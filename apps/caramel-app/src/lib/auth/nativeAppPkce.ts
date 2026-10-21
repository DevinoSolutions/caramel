// src/lib/auth/nativeAppPkce.ts
//
// PKCE (RFC 7636, S256) between the native app (iOS now, Android next) and OUR
// server, for the app's custom-scheme redirect (NATIVE_APP_REDIRECT_URI).
//
// Why it exists: a custom scheme is claimable by any app on the device, so the
// code that rides back on `com.devino.caramel://auth/callback` could be read by
// a malicious app that registered the same scheme and then traded at
// POST /api/extension/oauth for a Caramel session. The app therefore invents a
// secret verifier, sends only its SHA-256 (the challenge) to /authorize, and
// reveals the verifier only in the exchange POST, which never travels through
// the scheme. The provider is not involved: this is the app <-> Caramel leg.
//
// Extension redirect URIs are NOT subject to any of this (their redirects are
// origin-bound HTTPS/chrome-extension URIs the allowlist already pins).
import { createHash, timingSafeEqual } from 'crypto'

/** RFC 7636 §4.1: 43-128 characters of the unreserved set. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

/** RFC 7636 §4.2 for S256: base64url(SHA-256(verifier)) with no padding is
 * always exactly 43 characters. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/

export function isValidCodeChallenge(value: string): boolean {
    return CODE_CHALLENGE_PATTERN.test(value)
}

export function isValidCodeVerifier(value: string): boolean {
    return CODE_VERIFIER_PATTERN.test(value)
}

/** True when `verifier` is the pre-image of the S256 `challenge`. Constant-time
 * on the digest comparison. A malformed verifier or challenge never matches. */
export function codeVerifierMatchesChallenge(
    verifier: string,
    challenge: string,
): boolean {
    if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) {
        return false
    }
    const computed = Buffer.from(
        createHash('sha256').update(verifier).digest('base64url'),
    )
    const expected = Buffer.from(challenge)
    return (
        computed.length === expected.length &&
        timingSafeEqual(computed, expected)
    )
}
