import { preflight, withRoute } from '@/lib/api/withRoute'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import { createHmac } from 'crypto'
import { NextResponse } from 'next/server'

const OAUTH_STATE_SECRET = env.EXTENSION_OAUTH_STATE_SECRET

const createSignedState = (payload: {
    provider: 'google' | 'apple'
    redirectUri: string
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

        try {
            const baseURL = env.BETTER_AUTH_URL || BASE_URL

            // Construct OAuth URLs directly using OAuth provider endpoints
            // This bypasses better-auth's redirect handling which doesn't work well for extensions
            let oauthUrl: URL

            // Generate signed state for CSRF protection that can be validated on exchange
            const state = createSignedState({ provider, redirectUri })

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
            return NextResponse.json(
                {
                    error: `Internal server error while getting OAuth URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
                { status: 500 },
            )
        }
    },
)
