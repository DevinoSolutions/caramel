// POST /api/extension/oauth/google-id-token
//
// Native Google sign-in for the Android app (apps/caramel-android): the app
// gets a Google ID token from Credential Manager's "Sign in with Google"
// bottom sheet (the device's own Google accounts, no browser page) and trades
// it here for the same session bearer /api/extension/oauth mints after a code
// exchange. The token's audience is our web client (the app passes it as
// serverClientId), so no client secret and no redirect are involved.
//
// No PKCE/state here, unlike the app's code flow: there is no redirect for
// another app to intercept, and an ID token for our audience is only issued
// to our own registered clients.
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { mintExtensionSession } from '@/lib/auth/extensionOAuthSession'
import { verifyGoogleIdToken } from '@/lib/auth/googleIdToken'
import { env } from '@/lib/env'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const GoogleIdTokenBodySchema = z.object({
    idToken: z.string().min(1),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/oauth/google-id-token',
        // Called by native code only (no browser origin), so no CORS.
        cors: 'none',
        rateLimit: 'mutation',
        body: GoogleIdTokenBodySchema,
    },
    async ({ req, body }) => {
        const googleClientId = env.GOOGLE_CLIENT_ID
        if (!googleClientId) {
            return NextResponse.json(
                { error: 'Google OAuth not configured' },
                { status: 500 },
            )
        }

        try {
            const claims = await verifyGoogleIdToken(
                body.idToken,
                googleClientId,
            )
            if (!claims) {
                return NextResponse.json(
                    { error: 'Invalid or expired Google sign-in' },
                    { status: 401 },
                )
            }
            if (!claims.email) {
                return NextResponse.json(
                    { error: 'Email is required for Google sign-in' },
                    { status: 400 },
                )
            }
            // NF-07, as in the code-exchange route: only the provider's
            // verified-email claim gates the mint.
            if (!claims.emailVerified) {
                return NextResponse.json(
                    {
                        error: 'Your Google email address is not verified. Please verify it with Google and try again.',
                    },
                    { status: 403 },
                )
            }

            const minted = await mintExtensionSession({
                provider: 'google',
                providerUser: {
                    id: claims.sub,
                    email: claims.email,
                    name: claims.name,
                    image: claims.picture,
                    emailVerified: true,
                },
                tokens: { idToken: body.idToken },
            })
            return NextResponse.json(minted)
        } catch (error) {
            return handleRouteError(error, {
                req,
                message: 'Internal server error during native Google sign-in',
            })
        }
    },
)
