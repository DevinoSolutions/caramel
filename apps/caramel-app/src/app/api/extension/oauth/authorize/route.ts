import { handleRouteError } from '@/lib/api/handleRouteError'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import { isValidNonce } from '@/lib/extension-oauth-nonce'
import { createHmac } from 'crypto'
import { NextResponse } from 'next/server'

const OAUTH_STATE_SECRET = env.EXTENSION_OAUTH_STATE_SECRET

const createSignedState = (payload: {
    provider: 'google' | 'apple'
    redirectUri: string
    // ====================================================================
    // COMPATIBILITY SHIM for the shipped Safari/iOS build (store version
    // published 2026-04-29): remove after a poll-free Safari version ships.
    // TODO(safari-shim-removal)
    // ====================================================================
    // Present ONLY for the shipped Safari flow, which cannot capture an OAuth
    // redirect and instead polls for the result (see
    // src/lib/extension-oauth-nonce.ts). Carrying it INSIDE the signed state is
    // what lets /redirect recognize a Safari callback: the OAuth provider hands
    // the state back to us untouched, so the nonce survives the round trip
    // without the provider needing to know about it.
    //
    // Chrome/Firefox send no nonce and are byte-identically unaffected:
    // JSON.stringify drops an `undefined` value, so the signed payload for a
    // nonce-less call is exactly the string it was before this shim, and the
    // POST exchange's verifySignedState() re-hashes the decoded payload as-is
    // (it never re-serializes), so an EXTRA key cannot invalidate a signature.
    nonce?: string
}) => {
    if (!OAUTH_STATE_SECRET) {
        throw new Error('EXTENSION_OAUTH_STATE_SECRET is not configured')
    }

    const data = JSON.stringify({
        ...payload,
        iat: Date.now(),
    })

    const sig = createHmac('sha256', OAUTH_STATE_SECRET)
        .update(data)
        .digest('base64url')

    return `${Buffer.from(data).toString('base64url')}.${sig}`
}

// CORS (was 3x hand-inlined here — OPTIONS, a local getCorsHeaders()
// helper, and again re-created from scratch in the catch block, which
// didn't even call the local helper) and rate-limiting (previously
// absent despite this route doing HMAC signing + reading secrets on
// every call) both now come from withRoute's declarative config —
// PLAN-F-007.md's flagged gaps for this route.
export const OPTIONS = preflight({ cors: 'extension', methods: 'GET, OPTIONS' })

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/oauth/authorize',
        cors: 'extension',
        rateLimit: 'mutation',
    },
    async ({ req }) => {
        const { searchParams } = new URL(req.url)
        const provider = searchParams.get('provider') as
            | 'google'
            | 'apple'
            | null
        const redirectUri = searchParams.get('redirect_uri')
        // COMPATIBILITY SHIM (see createSignedState above) —
        // TODO(safari-shim-removal). Absent for Chrome/Firefox, which keeps
        // their behavior exactly as it was.
        const nonceParam = searchParams.get('nonce')

        if (!provider) {
            return NextResponse.json(
                { error: 'Missing provider parameter' },
                { status: 400 },
            )
        }

        if (provider !== 'google' && provider !== 'apple') {
            return NextResponse.json(
                { error: 'Invalid provider. Must be "google" or "apple"' },
                { status: 400 },
            )
        }

        if (!redirectUri) {
            return NextResponse.json(
                { error: 'Missing redirect_uri parameter' },
                { status: 400 },
            )
        }

        // A nonce outside the bounds /poll will look up would produce a state
        // whose result can never be collected — the popup would poll a dead
        // nonce for its full 5 minutes and then report a timeout. Refuse it
        // here instead, so the failure is legible at the call that caused it.
        // TODO(safari-shim-removal)
        if (nonceParam !== null && !isValidNonce(nonceParam)) {
            return NextResponse.json(
                { error: 'Invalid nonce parameter' },
                { status: 400 },
            )
        }
        const nonce = nonceParam ?? undefined

        try {
            const baseURL = env.BETTER_AUTH_URL || BASE_URL

            // Construct OAuth URLs directly using OAuth provider endpoints
            // This bypasses better-auth's redirect handling which doesn't work well for extensions
            let oauthUrl: URL

            // Generate signed state for CSRF protection that can be validated on exchange
            const state = createSignedState({ provider, redirectUri, nonce })

            if (provider === 'google') {
                // Google OAuth 2.0 authorization endpoint
                const googleClientId = env.GOOGLE_CLIENT_ID
                if (!googleClientId) {
                    return NextResponse.json(
                        { error: 'Google OAuth not configured' },
                        { status: 500 },
                    )
                }

                // IMPORTANT: For Chrome extensions, we MUST use the extension's redirect URI
                // This URI format is: https://[extension-id].chromiumapp.org/
                // This MUST be registered in Google Cloud Console as an authorized redirect URI
                //
                // We cannot use better-auth's callback URL because better-auth manages its own
                // state verification, and we need to bypass that for extension flows.
                oauthUrl = new URL(
                    'https://accounts.google.com/o/oauth2/v2/auth',
                )
                oauthUrl.searchParams.set('client_id', googleClientId)
                oauthUrl.searchParams.set('redirect_uri', redirectUri) // Use extension's redirect URI directly
                oauthUrl.searchParams.set('response_type', 'code')
                oauthUrl.searchParams.set('scope', 'openid email profile')
                oauthUrl.searchParams.set('access_type', 'offline')
                oauthUrl.searchParams.set('prompt', 'select_account')
                oauthUrl.searchParams.set('state', state) // Use our own state (not better-auth's)

                const authUrl = oauthUrl.toString()

                // Return the state for the extension to verify
                return NextResponse.json({
                    authorizationUrl: authUrl,
                    state, // Return original state
                })
            } else if (provider === 'apple') {
                // Apple OAuth 2.0 authorization endpoint
                const appleClientId = env.APPLE_CLIENT_ID
                if (!appleClientId) {
                    return NextResponse.json(
                        { error: 'Apple OAuth not configured' },
                        { status: 500 },
                    )
                }

                // Apple requires HTTPS redirect URIs (doesn't accept localhost or HTTP)
                if (!baseURL.startsWith('https://')) {
                    return NextResponse.json(
                        {
                            error: 'Apple OAuth requires HTTPS. Please set BETTER_AUTH_URL or NEXT_PUBLIC_BASE_URL to your HTTPS URL (e.g., ngrok URL).',
                            details: `Current baseURL: ${baseURL}. Apple does not accept HTTP or localhost redirect URIs.`,
                        },
                        { status: 400 },
                    )
                }

                // Apple requires form_post when requesting 'email' or 'name' scope
                // Since chrome.identity can't handle form_post directly, we use an intermediate redirect endpoint
                // that receives the POST from Apple and redirects to the extension's redirect URI
                const intermediateRedirectUri = `${baseURL}/api/extension/oauth/redirect`

                // Encode the extension redirect URI in the state so we can retrieve it after Apple POSTs back
                // Apple will POST the state back to us, and we'll decode it to get the extension redirect URI
                const stateWithRedirect = Buffer.from(
                    JSON.stringify({ r: redirectUri, s: state }),
                ).toString('base64')

                oauthUrl = new URL('https://appleid.apple.com/auth/authorize')
                oauthUrl.searchParams.set('client_id', appleClientId)
                oauthUrl.searchParams.set(
                    'redirect_uri',
                    intermediateRedirectUri,
                )
                oauthUrl.searchParams.set('response_type', 'code')
                oauthUrl.searchParams.set('scope', 'email')
                oauthUrl.searchParams.set('response_mode', 'form_post') // Required by Apple for email scope
                oauthUrl.searchParams.set('state', stateWithRedirect)

                const authUrl = oauthUrl.toString()

                // Return the original state (not the encoded one) for the extension to verify
                return NextResponse.json({
                    authorizationUrl: authUrl,
                    state, // Return original state for extension to verify
                })
            } else {
                return NextResponse.json(
                    { error: 'Invalid provider' },
                    { status: 400 },
                )
            }
        } catch (error) {
            console.error('OAuth authorization URL error:', error)
            // Route through the one error exit (Sentry + x-request-id) rather
            // than the old console.error-only 500 that bypassed Sentry and
            // leaked error.message into the response body.
            return handleRouteError(error, {
                req,
                message: 'Internal server error while getting OAuth URL',
            })
        }
    },
)
