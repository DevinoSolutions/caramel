// POST /api/extension/oauth/apple-id-token
//
// Native Sign in with Apple for the iOS app (apps/caramel-apple): the app
// shows Apple's own sheet (ASAuthorizationAppleIDProvider, Face ID, no web
// page) and trades the identity token here for the same session bearer
// /api/extension/oauth mints after a code exchange. The token's audience is
// the app's bundle id (appleNativeSignIn.ts), and it must carry the SHA-256 of
// the raw nonce sent alongside it.
//
// No PKCE/state, as in google-id-token: there is no redirect for another app
// to intercept, and Apple only issues a token for our bundle id to our app.
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import {
    redeemAppleNativeCode,
    verifyAppleNativeIdToken,
} from '@/lib/auth/appleNativeSignIn'
import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
import { env } from '@/lib/env'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const AppleIdTokenBodySchema = z.object({
    idToken: z.string().min(1),
    /** The raw nonce; the sheet was given its SHA-256. */
    nonce: z.string().min(16).max(256),
    /** One-time code from the same sheet, redeemed for the revocable grant. */
    authorizationCode: z.string().min(1).max(2048).optional(),
    /** Apple hands the name to the app only on the very first sign-in. */
    name: z.string().trim().min(1).max(200).optional(),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/oauth/apple-id-token',
        // Called by native code only (no browser origin), so no CORS.
        cors: 'none',
        rateLimit: 'mutation',
        body: AppleIdTokenBodySchema,
    },
    async ({ req, body }) => {
        // The same switch as the web flows: no Apple config, no Apple sign-in
        // (and no key to sign the code redeem's client secret with).
        if (!env.APPLE_CLIENT_ID) {
            return NextResponse.json(
                { error: 'Apple OAuth not configured' },
                { status: 500 },
            )
        }

        try {
            const claims = await verifyAppleNativeIdToken(
                body.idToken,
                body.nonce,
            )
            if (!claims) {
                return NextResponse.json(
                    { error: 'Invalid or expired Apple sign-in' },
                    { status: 401 },
                )
            }
            // NF-07, as in the code-exchange route: only the provider's
            // verified-email claim gates the mint.
            if (!claims.emailVerified) {
                return NextResponse.json(
                    {
                        error: 'Your Apple email address is not verified. Please verify it with Apple and try again.',
                    },
                    { status: 403 },
                )
            }

            const grant = body.authorizationCode
                ? await redeemAppleNativeCode(body.authorizationCode)
                : null

            const minted = await mintExtensionSession({
                provider: 'apple',
                providerUser: {
                    id: claims.sub,
                    email: claims.email,
                    name: body.name ?? null,
                    image: null,
                    emailVerified: true,
                },
                // The stored identity token tells revocation which client the
                // grant belongs to (appleTokenRevocation.ts), so it is stored
                // only together with that grant's tokens: without a redeemed
                // grant the account keeps the tokens it already had.
                tokens: grant
                    ? {
                          accessToken: grant.accessToken,
                          refreshToken: grant.refreshToken,
                          idToken: body.idToken,
                      }
                    : {},
            })
            return NextResponse.json(minted)
        } catch (error) {
            if (error instanceof ExtensionOAuthEmailRequiredError) {
                return NextResponse.json(
                    {
                        error: 'Email is required for Apple sign-in. Please share your email with Caramel.',
                    },
                    { status: 400 },
                )
            }
            return handleRouteError(error, {
                req,
                message: 'Internal server error during native Apple sign-in',
            })
        }
    },
)
