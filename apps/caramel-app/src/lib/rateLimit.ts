// src/lib/rateLimit.ts
//
// Per-IP rate limiting for public API routes. In-memory token buckets —
// sufficient for single-instance dev + prod. Swap to
// `RateLimiterRedis` (same API) when we scale to multiple instances.
//
// Design goals:
//   * be generous to real users (a page load bursts ~5 requests)
//   * be boring and predictable under scraping load
//   * fail open if the limiter itself throws (never block legitimate
//     traffic because of an internal bug)
//
// Limits are intentionally per-IP, not per-route, so a scraper pivoting
// between endpoints doesn't get a fresh budget on each one.
import { env } from '@/lib/env'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

export type LimitKind = 'read' | 'mutation'

// Per-minute sustained rate. Burst = the full minute's budget.
const LIMITS: Record<LimitKind, { points: number; duration: number }> = {
    // 120/min ≈ 2/sec sustained. A real user hitting /coupons pages
    // comes nowhere near this even with search + pagination.
    read: { points: 120, duration: 60 },
    // 30/min — /increment, /expire, /sources POST. Extension calls
    // /increment once per coupon copy, which is nowhere near this cap.
    mutation: { points: 30, duration: 60 },
}

// Short-window burst limiter catches rapid-fire attempts that would
// otherwise crawl under the per-minute budget (e.g. 15 req/sec for 8s).
const BURST = { points: 20, duration: 2 }

const limiters: Record<LimitKind, RateLimiterMemory> = {
    read: new RateLimiterMemory(LIMITS.read),
    mutation: new RateLimiterMemory(LIMITS.mutation),
}
const burstLimiter = new RateLimiterMemory(BURST)

function getClientIp(req: NextRequest): string {
    // Trusted in order: our own proxy (X-Real-IP), then the first
    // public IP in X-Forwarded-For. Fall back to a constant so that
    // when no headers are present (edge runtime, direct hits) we still
    // apply a global cap instead of silently letting everything through.
    const realIp = req.headers.get('x-real-ip')
    if (realIp) return realIp
    const xff = req.headers.get('x-forwarded-for')
    if (xff) {
        const first = xff.split(',')[0]?.trim()
        if (first) return first
    }
    return 'unknown'
}

/**
 * True for requests carrying the server-only COUPONS_ADMIN_SECRET bearer
 * (mirrors src/lib/health.ts's authorize()). This is the single trust
 * signal for both (a) the rate-limit exemption below and (b) the auth gate
 * on POST /api/coupons/expire (src/app/api/coupons/expire/route.ts) — one
 * checker, not two independently-written comparisons (F-003). The secret
 * never ships to the extension or any other client, unlike the retired
 * publicly-shipped extension key this replaces.
 */
export function isTrustedServer(req: NextRequest): boolean {
    const secret = env.COUPONS_ADMIN_SECRET
    if (!secret) return false
    const auth = req.headers.get('authorization') || ''
    return auth === `Bearer ${secret}`
}

function buildHeaders(kind: LimitKind, res: RateLimiterRes | null): Headers {
    const h = new Headers()
    h.set('X-RateLimit-Limit', String(LIMITS[kind].points))
    if (res) {
        h.set('X-RateLimit-Remaining', String(Math.max(0, res.remainingPoints)))
        h.set(
            'X-RateLimit-Reset',
            String(Math.ceil((Date.now() + res.msBeforeNext) / 1000)),
        )
    }
    return h
}

/**
 * Call at the top of a route handler. Returns null if the request is
 * allowed, or a ready-to-return 429 NextResponse if it is blocked.
 *
 * ```ts
 * const limited = await checkRateLimit(req, 'read')
 * if (limited) return limited
 * ```
 */
export async function checkRateLimit(
    req: NextRequest,
    kind: LimitKind = 'read',
): Promise<NextResponse | null> {
    if (isTrustedServer(req)) return null

    const ip = getClientIp(req)

    // Burst first — cheaper to reject here than to touch the minute
    // limiter. A hit against the burst limiter does NOT consume the
    // minute budget so a brief hiccup doesn't penalise the user
    // long-term.
    try {
        await burstLimiter.consume(ip, 1)
    } catch (error) {
        const res = (error as RateLimiterRes) ?? null
        const retryAfterSec = res
            ? Math.max(1, Math.ceil(res.msBeforeNext / 1000))
            : 2
        logAbuse(req, ip, 'burst', retryAfterSec)
        const headers = buildHeaders(kind, res)
        headers.set('Retry-After', String(retryAfterSec))
        return NextResponse.json(
            {
                error: 'Too many requests. Please slow down.',
                retryAfter: retryAfterSec,
            },
            { status: 429, headers },
        )
    }

    try {
        const res = await limiters[kind].consume(ip, 1)
        void res
        return null
    } catch (error) {
        const res = (error as RateLimiterRes) ?? null
        const retryAfterSec = res
            ? Math.max(1, Math.ceil(res.msBeforeNext / 1000))
            : 60
        logAbuse(req, ip, kind, retryAfterSec)
        const headers = buildHeaders(kind, res)
        headers.set('Retry-After', String(retryAfterSec))
        return NextResponse.json(
            {
                error: 'Too many requests. Please slow down.',
                retryAfter: retryAfterSec,
            },
            { status: 429, headers },
        )
    }
}

function logAbuse(
    req: NextRequest,
    ip: string,
    kind: string,
    retryAfterSec: number,
) {
    // One-line structured log so you can grep the dev console / prod
    // log aggregator for "[ratelimit]" to see abuse patterns.
    const path = new URL(req.url).pathname
    const ua = req.headers.get('user-agent')?.slice(0, 80) ?? '-'
    console.warn(
        `[ratelimit] kind=${kind} ip=${ip} path=${path} retry_after=${retryAfterSec}s ua="${ua}"`,
    )
}

/**
 * Allow-list check for mutation routes. Rejects cross-origin browser
 * requests from random websites. Accepts:
 *   - no Origin header (server-to-server, curl)
 *   - same-origin (our own Host)
 *   - chrome-extension:// / moz-extension:// / safari-web-extension://
 *   - any origin listed in ALLOWED_ORIGINS (comma-separated env var)
 */
export function isOriginAllowed(req: NextRequest): boolean {
    const origin = req.headers.get('origin')
    if (!origin) return true

    try {
        const originUrl = new URL(origin)
        // Browser extensions are trusted by protocol.
        if (
            originUrl.protocol === 'chrome-extension:' ||
            originUrl.protocol === 'moz-extension:' ||
            originUrl.protocol === 'safari-web-extension:'
        ) {
            return true
        }
        const host = req.headers.get('host')
        if (host && originUrl.host === host) return true

        // Raw process.env read (not the `env` singleton in src/lib/env.ts) —
        // pre-existing behavior, left as-is: out of scope for F-003 (see
        // PLAN-F-003.md), which only touches the retired extension-key
        // call sites (isTrustedServer above, and the routes that used to
        // check it directly).
        const allowed = (process.env.ALLOWED_ORIGINS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        if (allowed.includes(origin)) return true
        return false
    } catch {
        return false
    }
}

export function forbiddenOrigin(): NextResponse {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 })
}

/**
 * Stricter than isOriginAllowed(): requires the Origin header to be
 * PRESENT and to be an actual browser-extension origin (chrome-extension:
 * / moz-extension: / safari-web-extension:) — no same-origin exemption, no
 * ALLOWED_ORIGINS allowlist, and critically no missing-Origin bypass.
 *
 * isOriginAllowed()'s `if (!origin) return true` is deliberate for routes
 * that legitimately serve server-to-server/curl callers, but it left a
 * paid, extension-only, LLM-backed route (classify-cart) reachable with no
 * Origin at all (E2E report D5). Use this for routes that must only ever
 * be reachable from the extension itself. Deliberately NOT tied to the
 * KNOWN_EXTENSION_ORIGINS env allowlist (src/lib/api/withRoute.ts's `cors:
 * 'extension'` mode) — those vars are optional/unset in some deploys, and
 * a real extension's background-page fetch always carries an
 * `Origin: <protocol>://<id>` for ANY installed id regardless of server
 * config, so gating on protocol alone closes the D5 hole without adding a
 * dependency on that allowlist being exhaustively correct.
 */
export function isExtensionOrigin(req: NextRequest): boolean {
    const origin = req.headers.get('origin')
    if (!origin) return false
    try {
        const protocol = new URL(origin).protocol
        return (
            protocol === 'chrome-extension:' ||
            protocol === 'moz-extension:' ||
            protocol === 'safari-web-extension:'
        )
    } catch {
        return false
    }
}
