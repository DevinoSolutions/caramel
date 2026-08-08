import { withRoute } from '@/lib/api/withRoute'
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
 * from it. The cost is one loopback request.
 *
 * The caller's IP headers are forwarded so that POST's per-IP rate limit is
 * charged to the real user instead of pooling every Safari sign-in into one
 * bucket keyed by the loopback (Traefik sets these; we only pass them along).
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
    for (const name of ['x-real-ip', 'x-forwarded-for']) {
        const value = args.forwardHeaders.get(name)
        if (value) headers.set(name, value)
    }

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

    setNonceResult(args.nonce, {
        token: data.token,
        username: data.username ?? null,
        image: data.image ?? null,
    })

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
        code: args.code,
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
        // If there's an error, redirect to extension with error
        if (extensionRedirectUri) {
            const errorUrl = new URL(extensionRedirectUri)
            errorUrl.searchParams.set('error', error)
            if (originalState) errorUrl.searchParams.set('state', originalState)
            return NextResponse.redirect(errorUrl.toString())
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

    // Redirect to extension's redirect URI with the code
    // Use originalState (which may be the decoded state from Apple's response)
    let redirectUrl: URL
    try {
        redirectUrl = new URL(extensionRedirectUri)
    } catch {
        return NextResponse.json(
            { error: 'Invalid extension redirect URI' },
            { status: 400 },
        )
    }

    const isChromeExtension = redirectUrl.protocol === 'chrome-extension:'
    const isChromiumAppOrigin =
        redirectUrl.protocol === 'https:' &&
        redirectUrl.hostname.endsWith('.chromiumapp.org')

    if (!isChromeExtension && !isChromiumAppOrigin) {
        return NextResponse.json(
            { error: 'Disallowed extension redirect origin' },
            { status: 400 },
        )
    }

    redirectUrl.searchParams.set('code', code)
    if (originalState) redirectUrl.searchParams.set('state', originalState)

    return NextResponse.redirect(redirectUrl.toString())
}

// No cors/rateLimit/origin/apiKey/body concerns — this is a server-to-
// server OAuth-provider callback (Google/Apple POST or redirect here, not
// a browser CORS context), and throttling Google/Apple is wrong (see
// PLAN-F-007.md's route table). Wrapped ONLY for the F-002 error boundary
// withRoute provides for free: previously `handleRedirect` had no
// try/catch at all, so e.g. a malformed POST body threw an unhandled
// rejection instead of a clean {error} response.
export const GET = withRoute(
    { method: 'GET', routeName: 'extension/oauth/redirect' },
    async ({ req }) => handleRedirect(req),
)

export const POST = withRoute(
    { method: 'POST', routeName: 'extension/oauth/redirect' },
    async ({ req }) => handleRedirect(req),
)
