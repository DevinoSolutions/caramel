import { withRoute } from '@/lib/api/withRoute'
import { bindCodeToState } from '@/lib/auth/extensionOAuthCodeBinding'
import {
    isAllowedExtensionRedirectUri,
    isNativeAppRedirectUri,
    reportRejectedExtensionRedirect,
} from '@/lib/auth/extensionOAuthRedirect'
import { verifiedExtensionOAuthState } from '@/lib/auth/extensionOAuthState'
import { forwardClientIpHeaders } from '@/lib/clientIp'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import { isValidNonce, setNonceResult } from '@/lib/extension-oauth-nonce'
import { NextRequest, NextResponse } from 'next/server'

// ============================================================================
// COMPATIBILITY SHIM for the shipped Safari/iOS build (store version published
// 2026-04-29): remove after a poll-free Safari version ships. Everything below
// down to `handleRedirect` — plus the `nonce` branch at the top of it — is the
// shim; deleting it restores this route to the plain forward-the-code hop.
// TODO(safari-shim-removal)
// ============================================================================

/** The fields the shim needs out of the inner signed state. Parsed WITHOUT
 * verifying the signature — verification is the POST exchange's job, and this
 * route only uses the payload to decide *where* to send the code, never to
 * trust it. One parse for all three fields (the original shim parsed the same
 * string three times, once per field). */
function readSignedStatePayload(signedState: string): {
    nonce: string | null
    provider: 'google' | 'apple' | null
    redirectUri: string | null
} {
    const empty = { nonce: null, provider: null, redirectUri: null } as const
    const payloadB64 = signedState.split('.')[0]
    if (!payloadB64) return { ...empty }
    let payload: unknown
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    } catch {
        // Not our signed-state shape (e.g. a provider echoing something else
        // back). Treated as "no nonce" so the Chrome/Firefox path runs.
        return { ...empty }
    }
    if (typeof payload !== 'object' || payload === null) return { ...empty }
    const p = payload as Record<string, unknown>
    return {
        nonce: typeof p.nonce === 'string' ? p.nonce : null,
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

/** The end-of-flow page the Safari user lands on. They finish in a normal tab
 * (not an extension-controlled one), so this is the only feedback they get —
 * the extension itself learns the outcome from /poll. */
function htmlResponse(title: string, body: string, status = 200) {
    return new NextResponse(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#fff8f0;color:#3a2818;margin:0;padding:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:420px;padding:32px 24px;text-align:center}h1{margin:0 0 12px;font-size:22px}p{margin:0 0 8px;line-height:1.5;color:#5a4030}.tag{display:inline-block;padding:4px 10px;border-radius:999px;background:#fde0c1;color:#a64a00;font-size:12px;font-weight:600;margin-bottom:16px}</style></head><body><main>${body}</main></body></html>`,
        { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
}

function signInFailedPage(detail: string) {
    return htmlResponse(
        'Sign-in failed',
        `<span class="tag">Caramel</span><h1>Sign-in failed</h1><p>${detail}</p><p>You can close this tab and try again.</p>`,
        400,
    )
}

/**
 * Completes the OAuth exchange server-side and stashes the result for /poll.
 *
 * The exchange goes through this app's OWN POST /api/extension/oauth rather
 * than re-implementing it: that route is the single place a provider code
 * becomes a session (it verifies the signed state, enforces the provider's
 * verified-email claim, and mints via mintExtensionSession), so the Safari
 * path gets the exact same token class as every other client and cannot drift
 * from it. The cost is one extra request, made to the PUBLIC base URL.
 *
 * The caller's client-IP headers are forwarded (clientIp.ts owns which ones)
 * in the hope that POST's per-IP rate limit is charged per user rather than
 * pooling every Safari sign-in into one bucket.
 *
 * TODO(safari-shim-removal): that hope is unverified. The inner call goes out
 * through Cloudflare, which rewrites CF-Connecting-IP (the header the limiter
 * trusts first) to this server's own egress address, so the inner POST is
 * probably still metered under one shared key. Fixing it means calling the
 * exchange in-process instead of over HTTP, which is more than this shim
 * (already slated for removal) warrants.
 */
async function completeSafariOauth(args: {
    baseURL: string
    provider: 'google' | 'apple'
    code: string
    state: string
    redirectUri: string
    nonce: string
    forwardHeaders: Headers
}): Promise<{ ok: true } | { ok: false; error: string }> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    forwardClientIpHeaders(args.forwardHeaders, headers)

    let exchangeRes: Response
    try {
        exchangeRes = await fetch(`${args.baseURL}/api/extension/oauth`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                provider: args.provider,
                code: args.code,
                state: args.state,
                redirectUri: args.redirectUri,
            }),
        })
    } catch (err) {
        return {
            ok: false,
            error:
                err instanceof Error
                    ? err.message
                    : 'Internal exchange failure',
        }
    }

    if (!exchangeRes.ok) {
        const errorData = (await exchangeRes.json().catch(() => ({}))) as {
            error?: string
        }
        return {
            ok: false,
            error:
                errorData?.error ||
                `Token exchange failed (${exchangeRes.status})`,
        }
    }

    const data = (await exchangeRes.json().catch(() => ({}))) as {
        token?: string
        username?: string | null
        image?: string | null
    }

    if (!data.token) {
        return { ok: false, error: 'Missing token in exchange response' }
    }

    const stored = setNonceResult(args.nonce, {
        token: data.token,
        username: data.username ?? null,
        image: data.image ?? null,
    })
    if (!stored) {
        return { ok: false, error: 'Sign-in result store is full' }
    }

    return { ok: true }
}

/**
 * The shipped Safari flow's server-side leg: complete the exchange here and
 * leave the result for the popup to poll. Returns null when this callback is
 * NOT a Safari one, so the caller falls through to the normal forward path.
 * TODO(safari-shim-removal)
 */
async function handleSafariCallback(
    req: NextRequest,
    args: {
        signedState: string | null
        code: string | null
        error: string | null
    },
): Promise<NextResponse | null> {
    if (!args.signedState) return null
    const { nonce, provider, redirectUri } = readSignedStatePayload(
        args.signedState,
    )
    if (!nonce) return null

    // Nothing below (a stored result, an internal exchange) may run for a
    // state we did not sign: this route is unauthenticated, so an unverified
    // nonce would let anyone fill the nonce store or drive exchanges
    // (security audit 2026-10-21, M2). No sentinel is stored for it either:
    // a forged or expired state has no legitimate poller.
    if (!verifiedExtensionOAuthState(args.signedState)) {
        return signInFailedPage('This sign-in link is invalid or has expired.')
    }

    if (!isValidNonce(nonce)) {
        // Can only happen if someone hand-crafted a state; authorize refuses
        // these. No sentinel is stored — there is no legitimate poller.
        return signInFailedPage('Invalid sign-in request.')
    }

    if (args.error) {
        // Store the failure sentinel so the popup stops polling immediately
        // instead of waiting out its 5-minute deadline. The provider's own
        // message is NOT echoed into the page (it is attacker-influenced text
        // and this page is rendered as HTML).
        console.error('Safari OAuth provider error:', args.error)
        setNonceResult(nonce, { token: '', username: null, image: null })
        return signInFailedPage('The sign-in was cancelled or refused.')
    }

    if (!args.code) return signInFailedPage('Missing authorization code.')

    if (!provider || !redirectUri) {
        return signInFailedPage('Invalid state payload.')
    }

    const baseURL = env.BETTER_AUTH_URL || BASE_URL || new URL(req.url).origin

    const result = await completeSafariOauth({
        baseURL,
        provider,
        code: bindCodeToState(args.code, args.signedState),
        state: args.signedState,
        redirectUri,
        nonce,
        forwardHeaders: req.headers,
    })

    if (!result.ok) {
        // The popup must learn this failed; without the sentinel it polls for
        // the full TTL and reports a timeout instead of an error.
        console.error('Safari OAuth exchange failed:', result.error)
        setNonceResult(nonce, { token: '', username: null, image: null })
        return signInFailedPage('We could not complete the sign-in.')
    }

    return htmlResponse(
        'Sign-in successful',
        `<span class="tag">Caramel</span><h1>You're signed in</h1><p>Return to the Caramel extension to continue. You can close this tab.</p>`,
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

    // COMPATIBILITY SHIM — TODO(safari-shim-removal). A nonce inside the signed
    // state means the caller is the shipped Safari build, which has no redirect
    // URI to be sent back to and is polling instead. Returns null for every
    // other client, leaving the forward path below untouched.
    const safari = await handleSafariCallback(req, {
        signedState: originalState,
        code,
        error,
    })
    if (safari) return safari

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
