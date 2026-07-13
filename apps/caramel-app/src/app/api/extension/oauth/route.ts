import { handleRouteError } from '@/lib/api/handleRouteError'
import { preflight, withRoute } from '@/lib/api/withRoute'
import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import { createHmac, timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const OAUTH_STATE_SECRET = env.EXTENSION_OAUTH_STATE_SECRET

interface OAuthStatePayload {
    provider: string
    redirectUri: string
    iat: number
}

function verifySignedState(
    state: string,
    expected: { provider: 'google' | 'apple'; redirectUri: string },
): boolean {
    if (!OAUTH_STATE_SECRET) {
        console.error('EXTENSION_OAUTH_STATE_SECRET is not configured')
        return false
    }

    const [payloadB64, sig] = state.split('.')
    if (!payloadB64 || !sig) return false

    let payloadJson: string
    try {
        payloadJson = Buffer.from(payloadB64, 'base64url').toString()
    } catch {
        return false
    }

    const expectedSig = createHmac('sha256', OAUTH_STATE_SECRET)
        .update(payloadJson)
        .digest('base64url')

    const sigBuf = Buffer.from(sig)
    const expectedBuf = Buffer.from(expectedSig)

    if (sigBuf.length !== expectedBuf.length) {
        return false
    }

    if (!timingSafeEqual(sigBuf, expectedBuf)) {
        return false
    }

    let payload: OAuthStatePayload
    try {
        payload = JSON.parse(payloadJson)
    } catch {
        return false
    }

    if (payload.provider !== expected.provider) return false
    if (payload.redirectUri !== expected.redirectUri) return false

    if (typeof payload.iat !== 'number') return false
    const maxAgeMs = 5 * 60 * 1000
    if (Date.now() - payload.iat > maxAgeMs) return false

    return true
}

// Strict on presence/shape only (missing/invalid-typed provider/code/
// state/redirectUri -> 422 — PLAN-F-007.md §Breaking's flagged change for
// this route). The signed-state's cryptographic validity is NOT a
// body-shape concern — it stays verifySignedState()'s own manual 400
// "Invalid or expired OAuth state" below, same split as sources POST's
// website-plausibility check.
const OAuthExchangeBodySchema = z.object({
    provider: z.enum(['google', 'apple']),
    code: z.string().min(1),
    state: z.string().min(1),
    redirectUri: z.string().min(1),
})

// CORS TIGHTENS here: was any `chrome-extension://…` / `moz-extension://…`
// / `safari-web-extension://…` origin by prefix match; now the same exact
// env-allowlist authorize/route.ts already used (withRoute's cors:
// 'extension') — PLAN-F-007.md §Breaking. Rate-limit is NEW (this route
// used to have none despite minting sessions).
export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/oauth',
        cors: 'extension',
        rateLimit: 'mutation',
        body: OAuthExchangeBodySchema,
    },
    async ({ req, body }) => {
        const { provider, code, state, redirectUri } = body

        if (!verifySignedState(state, { provider, redirectUri })) {
            return NextResponse.json(
                { error: 'Invalid or expired OAuth state' },
                { status: 400 },
            )
        }

        try {
            const baseURL = env.BETTER_AUTH_URL || BASE_URL

            if (provider === 'google') {
                // Exchange authorization code for tokens directly with Google
                const googleClientId = env.GOOGLE_CLIENT_ID
                const googleClientSecret = env.GOOGLE_CLIENT_SECRET

                if (!googleClientId || !googleClientSecret) {
                    return NextResponse.json(
                        { error: 'Google OAuth not configured' },
                        { status: 500 },
                    )
                }

                // Exchange code for tokens
                const tokenResponse = await fetch(
                    'https://oauth2.googleapis.com/token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({
                            code,
                            client_id: googleClientId,
                            client_secret: googleClientSecret,
                            redirect_uri: redirectUri,
                            grant_type: 'authorization_code',
                        }),
                    },
                )

                if (!tokenResponse.ok) {
                    const errorData = await tokenResponse
                        .json()
                        .catch(() => ({}))
                    console.error('Google token exchange error:', errorData)
                    return NextResponse.json(
                        {
                            error:
                                errorData.error_description ||
                                'Failed to exchange authorization code for tokens',
                        },
                        { status: 400 },
                    )
                }

                const tokens = await tokenResponse.json()
                const { access_token, id_token } = tokens

                // Get user info from Google
                const userInfoResponse = await fetch(
                    'https://www.googleapis.com/oauth2/v2/userinfo',
                    {
                        headers: {
                            Authorization: `Bearer ${access_token}`,
                        },
                    },
                )

                if (!userInfoResponse.ok) {
                    return NextResponse.json(
                        {
                            error: 'Failed to fetch user information from Google',
                        },
                        { status: 500 },
                    )
                }

                const googleUser = await userInfoResponse.json()

                const userEmail = googleUser.email?.toLowerCase().trim()
                if (!userEmail) {
                    return NextResponse.json(
                        { error: 'Email is required for Google sign-in' },
                        { status: 400 },
                    )
                }

                const minted = await mintExtensionSession({
                    provider: 'google',
                    providerUser: {
                        id: googleUser.id,
                        email: userEmail,
                        name: googleUser.name || null,
                        image: googleUser.picture || null,
                        emailVerified: googleUser.verified_email || false,
                    },
                    tokens: { accessToken: access_token, idToken: id_token },
                })

                return NextResponse.json(minted)
            } else {
                // Apple OAuth flow
                const appleClientId = env.APPLE_CLIENT_ID
                const appleClientSecret = env.APPLE_CLIENT_SECRET

                if (!appleClientId || !appleClientSecret) {
                    return NextResponse.json(
                        { error: 'Apple OAuth not configured' },
                        { status: 500 },
                    )
                }

                // For Apple OAuth, we MUST use the intermediate redirect URI in the token exchange
                // because that's what was used in the authorization request
                // The extension redirect URI is only used for the final redirect to the extension
                const intermediateRedirectUri = `${baseURL}/api/extension/oauth/redirect`

                // Exchange code for tokens with Apple
                // IMPORTANT: Use intermediateRedirectUri, not the extension redirectUri
                // Apple requires the redirect_uri in token exchange to match the authorization request
                const tokenResponse = await fetch(
                    'https://appleid.apple.com/auth/token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({
                            code,
                            client_id: appleClientId,
                            client_secret: appleClientSecret,
                            redirect_uri: intermediateRedirectUri, // Use intermediate URI, not extension URI
                            grant_type: 'authorization_code',
                        }),
                    },
                )

                if (!tokenResponse.ok) {
                    const errorData = await tokenResponse
                        .json()
                        .catch(() => ({}))
                    console.error('Apple token exchange error:', errorData)
                    return NextResponse.json(
                        {
                            error:
                                errorData.error_description ||
                                errorData.error ||
                                'Failed to exchange authorization code for tokens',
                        },
                        { status: 400 },
                    )
                }

                const tokens = await tokenResponse.json()
                const { access_token, id_token } = tokens

                // Decode ID token to get user info
                // Apple's ID token is a JWT that contains user information
                if (!id_token) {
                    return NextResponse.json(
                        { error: 'Failed to receive ID token from Apple' },
                        { status: 500 },
                    )
                }

                // Decode JWT (we only need the payload, no verification needed for basic info)
                const idTokenParts = id_token.split('.')
                if (idTokenParts.length !== 3) {
                    return NextResponse.json(
                        { error: 'Invalid ID token format from Apple' },
                        { status: 500 },
                    )
                }

                // Decode base64url encoded payload
                const payload = JSON.parse(
                    Buffer.from(
                        idTokenParts[1].replace(/-/g, '+').replace(/_/g, '/'),
                        'base64',
                    ).toString(),
                )

                const appleUser = {
                    id: payload.sub, // Apple user ID
                    email: payload.email || null, // Email (may be null if user chose to hide it)
                    emailVerified: payload.email_verified || false,
                    name: null, // Name is not available in ID token when using email-only scope
                }

                try {
                    const minted = await mintExtensionSession({
                        provider: 'apple',
                        providerUser: {
                            id: appleUser.id,
                            email: appleUser.email,
                            name: appleUser.name,
                            image: null,
                            emailVerified: appleUser.emailVerified,
                        },
                        tokens: {
                            accessToken: access_token,
                            idToken: id_token,
                        },
                    })
                    return NextResponse.json(minted)
                } catch (error) {
                    if (error instanceof ExtensionOAuthEmailRequiredError) {
                        return NextResponse.json(
                            {
                                error: 'Email is required for Apple sign-in. Please ensure you grant email access.',
                            },
                            { status: 400 },
                        )
                    }
                    throw error
                }
            }
        } catch (error) {
            console.error('OAuth error:', error)
            return handleRouteError(error, {
                req,
                message: 'Internal server error during OAuth authentication',
            })
        }
    },
)
