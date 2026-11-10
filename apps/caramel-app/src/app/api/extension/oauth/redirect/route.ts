import { withRoute } from '@/lib/api/withRoute'
import { bindCodeToState } from '@/lib/auth/extensionOAuthCodeBinding'
import {
    isAllowedExtensionRedirectUri,
    isNativeAppRedirectUri,
    reportRejectedExtensionRedirect,
} from '@/lib/auth/extensionOAuthRedirect'
import { NextRequest, NextResponse } from 'next/server'

/** The fields this hop reads out of the inner signed state. Parsed WITHOUT
 * verifying the signature — verification is the POST exchange's job, and this
 * route only uses the payload to decide *where* to send the code (and to tag a
 * Sentry report), never to trust it. */
function readSignedStatePayload(signedState: string): {
    provider: 'google' | 'apple' | null
    redirectUri: string | null
} {
    const empty = { provider: null, redirectUri: null } as const
    const payloadB64 = signedState.split('.')[0]
    if (!payloadB64) return { ...empty }
    let payload: unknown
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    } catch {
        // Not our signed-state shape (e.g. a provider echoing something else
        // back): nothing to read.
        return { ...empty }
    }
    if (typeof payload !== 'object' || payload === null) return { ...empty }
    const p = payload as Record<string, unknown>
    return {
        provider:
            p.provider === 'google' || p.provider === 'apple'
                ? p.provider
                : null,
        redirectUri: typeof p.redirectUri === 'string' ? p.redirectUri : null,
    }
}

/** The provider named in the (unverified) signed state, for tagging a Sentry
 * report only: the redirect hop never trusts it, and a state that is not ours
 * (or has no provider) reports as 'unknown'. */
function providerOfState(
    signedState: string | null,
): 'google' | 'apple' | 'unknown' {
    return (
        (signedState && readSignedStatePayload(signedState).provider) ||
        'unknown'
    )
}

/** Sends the browser on to `target`. The extensions keep the default 307, as
 * before. The native app gets a 303: Apple's callback is a form POST, and a 307
 * would make the browser re-POST to a custom-scheme URL, whereas the sheet
 * (ASWebAuthenticationSession) intercepts a plain GET navigation to its scheme. */
function redirectTo(destination: string, target: URL): NextResponse {
    return isNativeAppRedirectUri(destination)
        ? NextResponse.redirect(target.toString(), 303)
        : NextResponse.redirect(target.toString())
}

/**
 * This endpoint handles redirects from OAuth providers (including form_post from Apple)
 * and forwards the authorization code to the extension's redirect URI
 */
async function handleRedirect(req: NextRequest) {
    let code: string | null = null
    let state: string | null = null
    let error: string | null = null
    const extensionRedirect = req.nextUrl.searchParams.get('extension_redirect')

    // Handle POST (form_post from Apple) or GET (query from Google)
    if (req.method === 'POST') {
        const formData = await req.formData()
        code = formData.get('code') as string | null
        state = formData.get('state') as string | null
        error = formData.get('error') as string | null
    } else {
        const { searchParams } = new URL(req.url)
        code = searchParams.get('code')
        state = searchParams.get('state')
        error = searchParams.get('error')
    }

    // Decode state to get extension redirect URI if it was encoded
    // For Apple (form_post), the state contains { r: extensionRedirectUri, s: originalState }
    // For Google (query), extensionRedirect may be in query params or we use state as-is
    let extensionRedirectUri = extensionRedirect
    let originalState = state
    if (state) {
        try {
            const decodedState = JSON.parse(
                Buffer.from(state, 'base64').toString(),
            )
            // If state contains encoded redirect URI, use it (Apple form_post flow)
            if (decodedState.r) {
                extensionRedirectUri = decodedState.r
            }
            if (decodedState.s) {
                originalState = decodedState.s
            }
        } catch {
            // State is not our encoded format, use it as-is (Google query flow or fallback)
            if (!extensionRedirectUri) {
                // If no extension redirect URI provided and state is not encoded,
                // this might be an error case
            }
        }
    }

    // The native app's Google leg: Google redirects (GET) straight here with
    // OUR signed state and no envelope or query param, so the destination can
    // only come from the state's own payload. Taken ONLY when it is exactly the
    // app's redirect URI; an unsigned-read destination of any other shape is
    // still ignored, so a hand-made state cannot steer the code anywhere new
    // (and the allowlist check below runs on the result regardless).
    if (!extensionRedirectUri && originalState) {
        const stateRedirect = readSignedStatePayload(originalState).redirectUri
        if (stateRedirect && isNativeAppRedirectUri(stateRedirect)) {
            extensionRedirectUri = stateRedirect
        }
    }

    if (error) {
        // Hand the provider's error back to the extension so it can render it
        // — but ONLY to one of our extensions. This branch used to redirect to
        // whatever `extension_redirect` said before any destination check ran,
        // which made grabcaramel.com an open redirect for phishing links
        // (security report 2026-10). A foreign destination gets the JSON 400.
        if (
            extensionRedirectUri &&
            isAllowedExtensionRedirectUri(extensionRedirectUri)
        ) {
            const errorUrl = new URL(extensionRedirectUri)
            errorUrl.searchParams.set('error', error)
            if (originalState) errorUrl.searchParams.set('state', originalState)
            return redirectTo(extensionRedirectUri, errorUrl)
        }
        if (extensionRedirectUri) {
            reportRejectedExtensionRedirect({
                route: 'extension/oauth/redirect',
                provider: providerOfState(originalState),
                redirectUri: extensionRedirectUri,
            })
        }
        return NextResponse.json({ error }, { status: 400 })
    }

    if (!code) {
        return NextResponse.json(
            { error: 'Missing authorization code' },
            { status: 400 },
        )
    }

    if (!extensionRedirectUri) {
        return NextResponse.json(
            { error: 'Missing extension redirect URI' },
            { status: 400 },
        )
    }

    // Only OUR extensions may receive the code. A shape check (any
    // chromiumapp.org host) let a third-party extension receive a Caramel
    // user's Apple code and exchange it for a session — see
    // extensionOAuthRedirect.ts. The destination comes from the UNSIGNED
    // outer `r` of the Apple envelope, so it is checked here even though
    // authorize also refuses foreign destinations: an attacker can rewrite
    // `r` in a legitimately-issued authorize URL.
    if (!isAllowedExtensionRedirectUri(extensionRedirectUri)) {
        reportRejectedExtensionRedirect({
            route: 'extension/oauth/redirect',
            provider: providerOfState(originalState),
            redirectUri: extensionRedirectUri,
        })
        return NextResponse.json(
            { error: 'Disallowed extension redirect origin' },
            { status: 400 },
        )
    }

    // Use originalState (which may be the decoded state from Apple's response).
    // The code is bound to that state (extensionOAuthCodeBinding.ts): the
    // exchange redeems it under no other state, so a code lifted from one
    // flow's callback cannot be traded under a state minted for another. With
    // no state there is nothing to bind to, and the exchange refuses a
    // state-less request anyway.
    const redirectUrl = new URL(extensionRedirectUri)
    redirectUrl.searchParams.set(
        'code',
        originalState ? bindCodeToState(code, originalState) : code,
    )
    if (originalState) redirectUrl.searchParams.set('state', originalState)

    return redirectTo(extensionRedirectUri, redirectUrl)
}

// No cors/origin/apiKey/body concerns: this is an OAuth-provider callback
// (Google redirects here, Apple form-posts here), not a browser CORS context.
// Both arrive FROM THE SHOPPER'S BROWSER (a redirect, an auto-submitted form),
// never from Google's or Apple's servers, so the per-IP 'mutation' bucket
// meters the shopper: one sign-in spends one point of its 30/min. It was
// unthrottled, which let anyone loop it (security audit 2026-10-21, M2).
// Wrapped also for the F-002 error boundary withRoute provides: previously
// `handleRedirect` had no try/catch at all, so e.g. a malformed POST body
// threw an unhandled rejection instead of a clean {error} response.
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/oauth/redirect',
        rateLimit: 'mutation',
    },
    async ({ req }) => handleRedirect(req),
)

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/oauth/redirect',
        rateLimit: 'mutation',
    },
    async ({ req }) => handleRedirect(req),
)
