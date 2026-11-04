// src/lib/devProof.ts
//
// T-9413 — the DEV-ONLY proof path. The native apps sign in with Google or
// Apple only, and a release build has to be walked signed-in (including account
// deletion) on an emulator before a tag goes out, without anyone creating a
// real external account. POST /api/dev-proof/session
// (src/app/api/dev-proof/session/route.ts) mints a session bearer for a
// throwaway `devproof+<slug>@devino.ca` user; this module is its policy.
//
// THE TWO GATES (RUNBOOK.md "Dev-only proof path (social-only sign-in apps)"):
//   1. `DEV_PROOF_SESSION_SECRET` exists ONLY in the DEV deployment's env. Unset
//      (production, every default) the route answers a bare 404, like a route
//      that does not exist.
//   2. Even with the secret set, a request whose host is a PRODUCTION host is
//      refused with the same 404 (`isProductionHost`, below), so a leaked env
//      line cannot turn production into a session mint.
// And one scope limit that makes the route unusable as an account-takeover
// tool: the body may name only an address matching DEV_PROOF_EMAIL_PATTERN.
//
// Nothing here is on any user-facing path, and nothing here may ever log the
// secret or a minted token.
import { readClientIp } from '@/lib/clientIp'
import * as Sentry from '@sentry/nextjs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

/**
 * The only address the route will mint for. `devproof+` prefix + a short slug on
 * Devino's own domain: strict on purpose, so the route can never name a real
 * person's account (no other domain, no other local part, no dots or plus-tags
 * to smuggle a different mailbox through). Lower-case only; the body is not
 * normalised, so `Devproof+X@devino.ca` is refused rather than rewritten.
 */
export const DEV_PROOF_EMAIL_PATTERN = /^devproof\+[a-z0-9-]{1,40}@devino\.ca$/

/** Calls per client IP per hour, allowed or not (a refused call spends it too). */
export const DEV_PROOF_CALLS_PER_HOUR = 10

const hourlyLimiter = new RateLimiterMemory({
    points: DEV_PROOF_CALLS_PER_HOUR,
    duration: 60 * 60,
})

/**
 * Hosts the route will not serve on. A DENYLIST on purpose (documented choice):
 * every `*.grabcaramel.com` name, including the apex, `www` and `docs.`, is
 * production-owned EXCEPT the one dev deployment, so a new production alias is
 * refused by default, while any non-grabcaramel host (localhost, the compose
 * service name, a CI runner, the Android emulator's 10.0.2.2) keeps working
 * without a code change. An allowlist would have to know every local name.
 */
const PRODUCTION_APEX = 'grabcaramel.com'
const DEV_HOST = 'dev.grabcaramel.com'

/** The hostname of ONE Host / X-Forwarded-Host entry or URL, or null when it has none. */
function hostnameOf(value: string): string | null {
    const entry = value.trim().toLowerCase()
    if (!entry) return null
    // `new URL` needs a scheme; a bare `host:port` has none.
    try {
        const hostname = new URL(
            entry.includes('://') ? entry : `http://${entry}`,
        ).hostname
        // A trailing dot is the same DNS name (`grabcaramel.com.`).
        return hostname.replace(/\.$/, '') || null
    } catch {
        return null
    }
}

export function isProductionHost(hostname: string): boolean {
    if (hostname === DEV_HOST) return false
    return (
        hostname === PRODUCTION_APEX || hostname.endsWith(`.${PRODUCTION_APEX}`)
    )
}

/**
 * True when ANY signal says this request is for a production host: the Host
 * header, X-Forwarded-Host (set by the proxy chain), the request URL, or the
 * app's own configured public origin (`publicOrigins`: BETTER_AUTH_URL and the
 * baked NEXT_PUBLIC_BASE_URL). The last one is the backstop: an app that
 * believes it IS grabcaramel.com refuses even if a proxy rewrote the Host.
 * Host and X-Forwarded-Host may be comma lists (each proxy hop appends): EVERY
 * entry is checked, so a production name anywhere in the chain refuses. A value
 * that cannot be parsed, an empty list entry included, counts as production
 * (fail closed).
 */
export function requestTouchesProductionHost(args: {
    host: string | null
    forwardedHost: string | null
    url: string
    publicOrigins: readonly (string | undefined)[]
}): boolean {
    const signals = [
        ...(args.host?.split(',') ?? []),
        ...(args.forwardedHost?.split(',') ?? []),
        args.url,
        ...args.publicOrigins,
    ].filter((value): value is string => value !== undefined)
    return signals.some(value => {
        const hostname = hostnameOf(value)
        return hostname === null || isProductionHost(hostname)
    })
}

/**
 * True when `authorization` is exactly `Bearer <secret>`. Both sides are hashed
 * to fixed-length SHA-256 digests first, so timingSafeEqual (which throws on
 * different lengths) always gets equal-length buffers and neither the verdict
 * nor the secret's length shows in the timing. A missing header takes the same
 * path as a wrong one.
 */
export function bearerMatches(
    authorization: string | null,
    secret: string,
): boolean {
    const provided = createHash('sha256')
        .update(authorization ?? '')
        .digest()
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
    return timingSafeEqual(provided, expected)
}

/**
 * A short, stable tag for the requester, for the audit line: HMAC-SHA-256 of
 * the client IP keyed with the dev-proof secret, so the tag cannot be reversed
 * to an address by hashing the IPv4 space, and means nothing without the secret.
 */
export function hashRequesterIp(headers: Headers, secret: string): string {
    const ip = readClientIp(headers) ?? 'unknown'
    return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 16)
}

/**
 * Spends one call from the requester's hourly budget. Returns true when the call
 * may proceed. Keyed by the requester hash (never the raw IP) in memory only.
 * Unlike checkRateLimit this does not fail open: an unexpected limiter fault
 * throws, because this route mints sessions.
 */
export async function consumeHourlyBudget(
    headers: Headers,
    secret: string,
): Promise<boolean> {
    try {
        await hourlyLimiter.consume(hashRequesterIp(headers, secret), 1)
        return true
    } catch (error) {
        if (error instanceof RateLimiterRes) return false
        throw error
    }
}

export type DevProofOutcome =
    | 'minted'
    | 'refused_production_host'
    | 'rate_limited'
    | 'unauthorized'
    | 'invalid_email'
    | 'error'

/**
 * One audit record per call to the route that got past the 404 gate, allowed or
 * refused: a structured log line plus a Sentry breadcrumb and an info-level
 * message, each carrying the outcome, the test email and the requester hash.
 * `email` is passed only when it matched DEV_PROOF_EMAIL_PATTERN (an attacker's
 * free text never reaches a log). The secret, the Authorization header and the
 * minted token are not parameters, so they cannot be logged from here.
 */
export function auditDevProofCall(entry: {
    outcome: DevProofOutcome
    email: string | null
    requesterHash: string
}): void {
    const record = { event: 'dev_proof_session', ...entry }
    console.info(`[dev-proof] ${JSON.stringify(record)}`)
    Sentry.addBreadcrumb({
        category: 'dev-proof',
        level: 'info',
        message: 'dev-proof session call',
        data: record,
    })
    Sentry.captureMessage(`dev-proof session call: ${entry.outcome}`, {
        level: 'info',
        tags: { route: 'dev-proof/session', outcome: entry.outcome },
        extra: record,
    })
}
