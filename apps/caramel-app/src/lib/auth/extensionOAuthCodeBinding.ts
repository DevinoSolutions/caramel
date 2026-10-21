// src/lib/auth/extensionOAuthCodeBinding.ts
//
// Ties an authorization code to the signed state it came back with.
//
// Every code that passes through our own /api/extension/oauth/redirect hop
// (all of Apple, the native app's Google leg, the Safari shim's Google leg) is
// exchanged with the SAME provider redirect_uri: the hop. So the provider
// cannot tell those flows apart, and before this module the exchange could not
// either: a code issued to one flow could be traded under a state issued to
// another. The concrete case (security audit 2026-10-21, H1): a code taken
// from the native app's callback could be exchanged under a fresh Safari-shim
// state, which carries no PKCE challenge, so the app's verifier was never
// asked for. For Apple, any valid state worked with any Apple code.
//
// The hop now forwards `cb1.<code>.<mac>` instead of the bare code, where the
// MAC covers the code AND the signed state it arrived with. The exchange only
// accepts a hop code whose MAC matches the state presented next to it, so a
// code can only ever be redeemed under the state (and so the PKCE challenge,
// redirect URI and provider) it was issued for. Clients never read the code;
// they pass it back verbatim, so the shipped builds need no change.
//
// Codes that never touch the hop (Google -> an extension's chromiumapp.org
// URI) are left alone: Google itself refuses to redeem them under any other
// redirect_uri, which is the binding the hop flows lacked.
import { env } from '@/lib/env'
import { createHmac, timingSafeEqual } from 'crypto'

const PREFIX = 'cb1'

function bindingKey(): Buffer {
    const secret = env.EXTENSION_OAUTH_STATE_SECRET
    if (!secret) {
        throw new Error('EXTENSION_OAUTH_STATE_SECRET is not configured')
    }
    // A key of its own, so a code MAC can never double as a state signature.
    return createHmac('sha256', secret)
        .update('extension-oauth-code-binding')
        .digest()
}

function macFor(code: string, state: string): string {
    return createHmac('sha256', bindingKey())
        .update(`${code}\n${state}`)
        .digest('base64url')
}

/** The code the hop forwards: the provider's code, bound to `state`. */
export function bindCodeToState(code: string, state: string): string {
    const encoded = Buffer.from(code).toString('base64url')
    return `${PREFIX}.${encoded}.${macFor(code, state)}`
}

/** True when `code` has the bound shape (whatever its MAC says). */
export function isBoundCode(code: string): boolean {
    return code.startsWith(`${PREFIX}.`)
}

/** The provider's code, when `bound` was bound to exactly `state`; else null. */
export function codeBoundToState(bound: string, state: string): string | null {
    const parts = bound.split('.')
    if (parts.length !== 3 || parts[0] !== PREFIX) return null
    const [, encoded, mac] = parts
    if (!encoded || !mac) return null
    const code = Buffer.from(encoded, 'base64url').toString()
    if (!code) return null
    const expected = Buffer.from(macFor(code, state))
    const given = Buffer.from(mac)
    if (given.length !== expected.length) return null
    return timingSafeEqual(given, expected) ? code : null
}
