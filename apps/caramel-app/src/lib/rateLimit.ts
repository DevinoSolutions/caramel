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
// between endpoints doesn't get a fresh budget on each one. The one exception
// is 'telemetry' (below): a deliberately chatty, low-value, anonymous route
// gets its OWN bucket, keyed ip+route, so its traffic can never spend the
// budget real work (a code submission, a sign-in) depends on.
import { reportRateLimitRejection } from '@/lib/abuseSignal'
import { readClientIp } from '@/lib/clientIp'
import { env } from '@/lib/env'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

export type LimitKind = 'read' | 'mutation' | 'telemetry'

// Per-minute sustained rate. Burst = the full minute's budget.
const LIMITS: Record<LimitKind, { points: number; duration: number }> = {
    // 120/min ≈ 2/sec sustained. A real user hitting /coupons pages
    // comes nowhere near this even with search + pagination.
    read: { points: 120, duration: 60 },
    // 30/min — /increment, /expire, /sources POST. Extension calls
    // /increment once per coupon copy, which is nowhere near this cap.
    mutation: { points: 30, duration: 60 },
    // 60/min per ip+route, in its OWN bucket and exempt from the shared burst
    // limiter below. The extension's opt-in funnel diagnostics report one
    // step per call and a single checkout can legitimately emit half a dozen
    // within a second; if that traffic drew on 'mutation' or on the shared
    // per-IP burst it could 429 the shopper's actual code submission.
    telemetry: { points: 60, duration: 60 },
}

// Short-window burst limiter catches rapid-fire attempts that would
// otherwise crawl under the per-minute budget (e.g. 15 req/sec for 8s).
const BURST = { points: 20, duration: 2 }

const limiters: Record<LimitKind, RateLimiterMemory> = {
    read: new RateLimiterMemory(LIMITS.read),
    mutation: new RateLimiterMemory(LIMITS.mutation),
    telemetry: new RateLimiterMemory(LIMITS.telemetry),
}
const burstLimiter = new RateLimiterMemory(BURST)

export function getClientIp(req: NextRequest): string {
    // Header order (CF-Connecting-IP first) is load-bearing and lives with
    // its explanation in clientIp.ts, shared with Better Auth's own limiter.
    // No headers at all (edge runtime, direct hits): a shared bucket is still
    // better than letting everything through unmetered.
    return readClientIp(req.headers) ?? 'unknown'
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

// Failed-bearer budget: 10 wrong bearers per minute per client IP, then 429.
// A supplier with a correct key never spends it (see checkBearerFailureLimit).
const BEARER_FAILURE = { points: 10, duration: 60 }
const bearerFailureLimiter = new RateLimiterMemory(BEARER_FAILURE)

/**
 * Counts one FAILED bearer check (ingest/* INGEST_API_KEY, coupons/expire
 * COUPONS_ADMIN_SECRET) against the caller's IP. Call it ONLY after the
 * bearer comparison failed; a request that presented the right bearer never
 * gets here, so it neither spends the budget nor is ever answered 429 by it.
 *
 * Returns null while the IP is within its budget (the caller answers its
 * normal 401), or a ready 429 once it is not. Either way the failure leaves a
 * breadcrumb and an abuse count (abuseSignal.ts escalates a sustained run to
 * Sentry + PostHog once), so a key-guessing run is visible, not just slow.
 * The throttle is on the response: it cannot stop a correct guess from
 * passing, which is why the secrets must be long and random (not verified
 * here; see T-6230).
 */
export async function checkBearerFailureLimit(
    req: NextRequest,
): Promise<NextResponse | null> {
    const ip = getClientIp(req)
    try {
        await bearerFailureLimiter.consume(ip, 1)
        logAbuse(req, ip, 'bearer-auth-fail', 0)
        return null
    } catch (error) {
        // consume() rejects with a RateLimiterRes when the budget is spent and
        // with an Error for a real fault; only the first is a 429.
        if (!(error instanceof RateLimiterRes)) throw error
        const retryAfterSec = Math.max(1, Math.ceil(error.msBeforeNext / 1000))
        logAbuse(req, ip, 'bearer-auth-fail', retryAfterSec)
        const headers = new Headers()
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

    // 'telemetry' is isolated: its own bucket keyed ip+route, and it neither
    // reads nor consumes the shared burst limiter or any other kind's budget.
    if (kind === 'telemetry') {
        const path = new URL(req.url).pathname
        try {
            await limiters.telemetry.consume(`${ip}|${path}`, 1)
            return null
        } catch (error) {
            return tooManyRequests(req, ip, kind, error as RateLimiterRes, 60)
        }
    }

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

function tooManyRequests(
    req: NextRequest,
    ip: string,
    kind: LimitKind,
    res: RateLimiterRes | null,
    fallbackRetrySec: number,
): NextResponse {
    const retryAfterSec = res
        ? Math.max(1, Math.ceil(res.msBeforeNext / 1000))
        : fallbackRetrySec
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
    // …and the same rejection to Sentry/PostHog, because a log line inside the
    // container is invisible to everyone who isn't already SSH'd into prod
    // (see src/lib/abuseSignal.ts's header for the 2026-09-16 measurement).
    // Deliberately NOT awaited: the 429 response must not wait on telemetry,
    // and reportRateLimitRejection never rejects — it reports its own failures.
    void reportRateLimitRejection({
        ip,
        path,
        kind,
        userAgent: ua,
        retryAfterSec,
    })
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
