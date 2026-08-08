// src/lib/extension-oauth-nonce.ts
//
// ============================================================================
// COMPATIBILITY SHIM for the shipped Safari/iOS build (store version published
// 2026-04-29): remove after a poll-free Safari version ships.
// TODO(safari-shim-removal)
// ============================================================================
//
// The shipped Safari/iOS extension signs in by handing /authorize a `nonce`,
// letting the OAuth exchange finish SERVER-SIDE on the /redirect leg, then
// polling GET /api/extension/oauth/poll?nonce=… until the session token comes
// back. Safari's popup is destroyed the moment the auth tab takes focus and
// `identity.launchWebAuthFlow` is not reliably available there, so the client
// cannot capture a redirect URL the way Chrome/Firefox do — the poll IS the
// handoff. That code was removed from this tree along with the Safari client;
// this module (plus the poll route and the nonce branches in
// authorize/redirect) exists ONLY so the ALREADY-PUBLISHED build keeps working
// after the cutover. Nothing in this repo's own extension calls it.
//
// STORAGE — in-memory, deliberately:
//   * That is what the shipped flow was built and published against (the
//     original lived on `globalThis`, same as here), so this reproduces proven
//     behavior rather than inventing new persistence.
//   * Migrations are frozen for the cutover, so a table is not an option, and
//     a nonce is worth persisting for all of 5 minutes anyway.
//   * The deployment is a SINGLE app instance (one root compose service), so
//     the /redirect write and the /poll read always land in the same process.
//     If the app is ever scaled to >1 instance or put behind a rolling deploy,
//     a mid-sign-in poll can miss its entry and the user simply signs in again
//     — the entries are one-shot and expire on their own.
//   * A deploy/restart drops in-flight nonces. The shipped client tolerates
//     that: it stops polling on the TTL it stored locally.
//
// The token lifetime here is the NONCE's, not the session's: entries are
// one-shot (consumed on first successful read) and expire after 5 minutes,
// matching SAFARI_OAUTH_TTL_MS in the shipped popup.js so client and server
// give up at the same moment.

type NonceEntry = {
    /** Empty string is the sign-in-FAILED sentinel the poll route turns into
     * a 400 — see the poll route's comment. Never a valid token. */
    token: string
    username: string | null
    image: string | null
    expiresAt: number
}

declare global {
    var extensionOauthNonceStore: Map<string, NonceEntry> | undefined
}

/** Matches SAFARI_OAUTH_TTL_MS in the shipped popup.js (5 min). */
const TTL_MS = 5 * 60 * 1000

// Survives Next's dev-mode module reloads, which would otherwise hand
// /redirect and /poll two different Maps.
const store: Map<string, NonceEntry> =
    globalThis.extensionOauthNonceStore ?? new Map<string, NonceEntry>()
globalThis.extensionOauthNonceStore = store

/** The nonce shape /authorize accepts and /poll looks up. The shipped client
 * sends a `crypto.randomUUID()` (36 chars); the bounds are the ORIGINAL poll
 * route's, kept identical so a nonce that authorize accepts is always one poll
 * can look up. */
const NONCE_MIN_LENGTH = 16
const NONCE_MAX_LENGTH = 128

export function isValidNonce(
    nonce: string | null | undefined,
): nonce is string {
    return (
        typeof nonce === 'string' &&
        nonce.length >= NONCE_MIN_LENGTH &&
        nonce.length <= NONCE_MAX_LENGTH
    )
}

/** Drops entries nobody ever polled for. The original never swept, so an
 * abandoned sign-in leaked its entry until the process restarted; sweeping on
 * write keeps the map bounded by concurrent sign-ins rather than by total
 * abandoned ones. */
function sweepExpired(now: number): void {
    // forEach, not for-of: the project's tsc target predates downlevel Map
    // iteration. Collect first so the map is not mutated mid-iteration.
    const stale: string[] = []
    store.forEach((entry, key) => {
        if (now > entry.expiresAt) stale.push(key)
    })
    for (const key of stale) store.delete(key)
}

export function setNonceResult(
    nonce: string,
    value: Omit<NonceEntry, 'expiresAt'>,
): void {
    const now = Date.now()
    sweepExpired(now)
    store.set(nonce, { ...value, expiresAt: now + TTL_MS })
}

/** One-shot read: a hit is deleted whether or not it had expired, so a nonce
 * can never be redeemed twice. */
export function consumeNonceResult(nonce: string): NonceEntry | null {
    const entry = store.get(nonce)
    if (!entry) return null
    store.delete(nonce)
    if (Date.now() > entry.expiresAt) return null
    return entry
}

/** Test-only reset — the store is a module-level singleton on globalThis, so
 * suites would otherwise leak entries into each other. */
export function resetNonceStoreForTests(): void {
    store.clear()
}
