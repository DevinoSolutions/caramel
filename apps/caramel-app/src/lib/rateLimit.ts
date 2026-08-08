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
import { createHash, timingSafeEqual } from 'node:crypto'
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

export function getClientIp(req: NextRequest): string {
    // CF-Connecting-IP FIRST, and this ordering is load-bearing.
    //
    // grabcaramel.com is proxied by Cloudflare, and Traefik behind it sets
    // X-Real-IP to ITS OWN peer — the Cloudflare edge — not to the visitor.
    // Preferring X-Real-IP therefore handed every visitor on earth the SAME
    // rate-limit key, i.e. one global bucket. Measured on dev 2026-08-08 with
    // a clean 75s window: a 30-request burst from a proxy exit returned 429s,
    // and the very next request from a DIFFERENT machine that had been idle
    // was also 429. Both directions of that are bad — 20 requests in 2s from
    // one host could 429 the API for every real user (a trivial DoS), while a
    // scraper rotating IPs got no per-client throttle at all.
    //
    // Cloudflare always sets CF-Connecting-IP to the true client and strips
    // any client-supplied copy, so it is the only header here a caller cannot
    // forge through the edge. X-Real-IP / X-Forwarded-For stay as fallbacks
    // for topologies without Cloudflare (local dev, direct origin hits), where
    // the old behaviour is unchanged.
    const cfIp = req.headers.get('cf-connecting-ip')?.trim()
    if (cfIp) return cfIp
    const realIp = req.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp
    const xff = req.headers.get('x-forwarded-for')
    if (xff) {
        const first = xff.split(',')[0]?.trim()
        if (first) return first
    }
    // No headers at all (edge runtime, direct hits): a shared bucket is still
    // better than letting everything through unmetered.
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
    // Constant-time comparison: hash both sides to fixed-length 32-byte
    // SHA-256 digests before timingSafeEqual (which THROWS on length-
    // mismatched inputs), so neither the match result nor the secret's
    // length leaks through a timing side-channel. Fail-closed semantics are
    // unchanged: an unset secret (handled above), a missing header, and a
    // malformed/wrong header all return false.
    const provided = createHash('sha256').update(auth).digest()
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
    return timingSafeEqual(provided, expected)
}

/**
 * True for requests carrying the server-only INGEST_API_KEY bearer — the coupons
 * pipeline supplier's auth for POST /api/ingest/catalog (withRoute's
 * apiKey:'ingest' gate). Modeled exactly on isTrustedServer: fail-closed on an
 * unset key, and a constant-time SHA-256 + timingSafeEqual comparison so neither
 * the match result nor the secret length leaks through timing. A DISTINCT secret
 * from COUPONS_ADMIN_SECRET (the ingest supplier and the admin/expire caller are
 * different principals) with its own one checker — never shipped to any client.
 */
export function isIngestAuthorized(req: NextRequest): boolean {
    const secret = env.INGEST_API_KEY
    if (!secret) return false
    const auth = req.headers.get('authorization') || ''
    const provided = createHash('sha256').update(auth).digest()
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
    return timingSafeEqual(provided, expected)
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

        // ALLOWED_ORIGINS flows through the zod env door (src/lib/env.ts,
        // `ALLOWED_ORIGINS: z.string().default('')`) like every other server
        // var — no raw `process.env` read (now banned by eslint
        // no-restricted-syntax, DESIGN.md §1). `env` is already this module's
        // singleton (isTrustedServer above reads env.COUPONS_ADMIN_SECRET);
        // the empty-string default preserves the prior unset→empty semantics
        // exactly, so `''.split(',').filter(Boolean)` still yields `[]`.
        const allowed = env.ALLOWED_ORIGINS.split(',')
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
