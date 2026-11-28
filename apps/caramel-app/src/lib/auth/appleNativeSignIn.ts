// src/lib/auth/appleNativeSignIn.ts
//
// Native Sign in with Apple for the iOS app (apps/caramel-apple), for
// POST /api/extension/oauth/apple-id-token. The app shows Apple's own sheet
// (ASAuthorizationAppleIDProvider: Face ID, no web page, no "Caramel Wants to
// Use appleid.apple.com" prompt) and sends the identity token and one-time
// authorization code it gets back.
//
// Both belong to the APP's client id, the bundle id, not to the Services ID
// (env.APPLE_CLIENT_ID) the web and extension flows use: the identity token's
// `aud` is the bundle id, and the code is redeemed with client_id = bundle id
// and a client secret signed with the bundle id as `sub`. Apple's user id
// (`sub`) is per team, so the same Apple ID finds the same account whichever
// client signed it in.
import 'server-only'

import * as Sentry from '@sentry/nextjs'
import { createHash } from 'node:crypto'

import { getAppleClientSecret } from '@/lib/auth/appleClientSecret'
import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

/** PRODUCT_BUNDLE_IDENTIFIER of the Caramel target in
 * apps/caramel-apple/project.yml: the `aud` of the app's identity tokens. */
export const APPLE_NATIVE_APP_CLIENT_ID = 'com.devino.Caramel'

const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token'
/** Bounds a hung connection only; Apple answers in well under a second. */
const APPLE_TOKEN_TIMEOUT_MS = 10_000

// jose caches the key set and refetches on an unknown `kid`.
const appleKeys = createRemoteJWKSet(
    new URL('https://appleid.apple.com/auth/keys'),
)

// The jose errors that are a verdict on the TOKEN (as in googleIdToken.ts).
// Failing to reach Apple's key set is ours to report, so it propagates.
const TOKEN_VERDICTS = [
    errors.JWTClaimValidationFailed,
    errors.JWTExpired,
    errors.JWTInvalid,
    errors.JWSInvalid,
    errors.JWSSignatureVerificationFailed,
    errors.JOSEAlgNotAllowed,
    errors.JWKSNoMatchingKey,
    errors.JWKSMultipleMatchingKeys,
]

export interface AppleIdTokenClaims {
    sub: string
    email: string | null
    emailVerified: boolean
}

/** Hex SHA-256, the form the app puts in the request's `nonce` (and Apple
 * copies into the token): the raw nonce only travels in our own POST. */
export function appleNonceHash(rawNonce: string): string {
    return createHash('sha256').update(rawNonce, 'utf8').digest('hex')
}

/**
 * The claims of a valid identity token the iOS app's sheet issued for
 * `rawNonce`, or null when it is not one (bad signature, wrong issuer or
 * audience, expired, nonce missing or for another request). Failing to REACH
 * Apple's key set throws, so the route answers 500 rather than 401.
 */
export async function verifyAppleNativeIdToken(
    idToken: string,
    rawNonce: string,
): Promise<AppleIdTokenClaims | null> {
    try {
        const { payload } = await jwtVerify(idToken, appleKeys, {
            issuer: APPLE_ISSUER,
            audience: APPLE_NATIVE_APP_CLIENT_ID,
        })
        if (typeof payload.sub !== 'string' || payload.sub === '') return null
        // Replay guard: the token must answer the nonce this request carries.
        if (payload.nonce !== appleNonceHash(rawNonce)) return null
        return {
            sub: payload.sub,
            email:
                typeof payload.email === 'string'
                    ? payload.email.toLowerCase().trim()
                    : null,
            // Apple sends a boolean OR the string "true"/"false".
            emailVerified:
                payload.email_verified === true ||
                payload.email_verified === 'true',
        }
    } catch (error) {
        if (TOKEN_VERDICTS.some(verdict => error instanceof verdict)) {
            return null
        }
        throw error
    }
}

export interface AppleNativeGrantTokens {
    accessToken: string
    refreshToken: string
}

function reportCodeRedeemFailure(
    reason: string,
    extra: Record<string, string | number>,
): void {
    const error = new Error(`Apple native code redeem failed: ${reason}`)
    error.name = 'AppleNativeCodeRedeemError'
    // Reasons, status codes and Apple's error code only: never the code.
    Sentry.captureException(error, {
        level: 'error',
        tags: {
            route: 'extension/oauth/apple-id-token',
            provider: 'apple',
            reason,
        },
        extra,
    })
}

/**
 * Redeems the sheet's one-time authorization code for the grant's tokens,
 * kept so account deletion can revoke the grant (appleTokenRevocation.ts,
 * App Review 5.1.1(v)). The identity token already proved who signed in, so
 * a failed redeem does not refuse the sign-in: it returns null after
 * reporting the reason to Sentry, and the account keeps the tokens it had.
 */
export async function redeemAppleNativeCode(
    authorizationCode: string,
): Promise<AppleNativeGrantTokens | null> {
    let response: Response
    try {
        response = await fetch(APPLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: APPLE_NATIVE_APP_CLIENT_ID,
                client_secret: getAppleClientSecret(APPLE_NATIVE_APP_CLIENT_ID),
                code: authorizationCode,
                grant_type: 'authorization_code',
            }),
            signal: AbortSignal.timeout(APPLE_TOKEN_TIMEOUT_MS),
        })
    } catch (cause) {
        // secret signing or transport failed
        reportCodeRedeemFailure('request_not_completed', {
            cause: cause instanceof Error ? cause.message : String(cause),
        })
        return null
    }

    const body: unknown = await response.json().catch(() => null)
    const record =
        typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)
            : {}
    if (!response.ok) {
        reportCodeRedeemFailure('apple_rejected', {
            status: response.status,
            appleError:
                typeof record.error === 'string'
                    ? record.error
                    : 'no_error_field',
        })
        return null
    }
    // Both or nothing: the stored tokens and identity token must all belong
    // to one grant, or revocation would send them to the wrong client.
    if (
        typeof record.access_token !== 'string' ||
        typeof record.refresh_token !== 'string'
    ) {
        reportCodeRedeemFailure('tokens_missing', { status: response.status })
        return null
    }
    return {
        accessToken: record.access_token,
        refreshToken: record.refresh_token,
    }
}
