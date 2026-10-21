// src/lib/auth/extensionOAuthState.ts
//
// THE check of the signed state /api/extension/oauth/authorize issues: its
// HMAC and its age. The code exchange (POST /api/extension/oauth) adds its own
// provider/redirect-URI match on top; the redirect hop uses it alone, so it
// never acts on a state it did not sign (security audit 2026-10-21, M2).
import { env } from '@/lib/env'
import { createHmac, timingSafeEqual } from 'crypto'

export interface ExtensionOAuthStatePayload {
    provider: string
    redirectUri: string
    iat: number
    /** Safari shim only. TODO(safari-shim-removal) */
    nonce?: unknown
    /**
     * The Safari flow's install id + first-touch record, signed into the state
     * by /authorize (its exchange runs server-side, so the extension cannot
     * put them in the POST body). Unvalidated shape here: re-validated on read.
     */
    attribution?: { iid?: unknown; firstTouch?: unknown }
    /** The native app's PKCE S256 challenge, signed in by /authorize. */
    codeChallenge?: unknown
}

/** How long a signed state stays redeemable. */
export const EXTENSION_OAUTH_STATE_MAX_AGE_MS = 5 * 60 * 1000

/** The state's payload when its signature and age hold; else null. */
export function verifiedExtensionOAuthState(
    state: string,
): ExtensionOAuthStatePayload | null {
    const secret = env.EXTENSION_OAUTH_STATE_SECRET
    if (!secret) {
        console.error('EXTENSION_OAUTH_STATE_SECRET is not configured')
        return null
    }

    const [payloadB64, sig] = state.split('.')
    if (!payloadB64 || !sig) return null

    let payloadJson: string
    try {
        payloadJson = Buffer.from(payloadB64, 'base64url').toString()
    } catch {
        return null
    }

    const expectedSig = createHmac('sha256', secret)
        .update(payloadJson)
        .digest('base64url')

    const sigBuf = Buffer.from(sig)
    const expectedBuf = Buffer.from(expectedSig)
    if (sigBuf.length !== expectedBuf.length) return null
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null

    let payload: ExtensionOAuthStatePayload
    try {
        payload = JSON.parse(payloadJson)
    } catch {
        return null
    }
    if (typeof payload !== 'object' || payload === null) return null

    if (typeof payload.iat !== 'number') return null
    if (Date.now() - payload.iat > EXTENSION_OAUTH_STATE_MAX_AGE_MS) return null

    return payload
}
