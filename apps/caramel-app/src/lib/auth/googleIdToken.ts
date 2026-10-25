// src/lib/auth/googleIdToken.ts
//
// Verifies a Google ID token that a native app obtained on the device
// (Android Credential Manager "Sign in with Google"), for
// POST /api/extension/oauth/google-id-token.
//
// The token is requested with our WEB client id as serverClientId, so its
// `aud` is env.GOOGLE_CLIENT_ID: the same audience the web and extension
// flows already trust. Signature (Google's JWKS), issuer, audience and expiry
// are all checked here; the caller still gates on `email_verified`, like the
// code-exchange route does with userinfo's `verified_email`.
import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

// jose caches the key set and refetches on an unknown `kid`.
const googleKeys = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
)

// The jose errors that are a verdict on the TOKEN. Everything else (a
// timeout or non-200 from the key set, a TypeError from fetch) is ours to
// report, so it propagates.
const TOKEN_VERDICTS = [
    errors.JWTClaimValidationFailed,
    // Not a subclass of JWTClaimValidationFailed in jose 6 (it only
    // implements its shape), so it is listed on its own.
    errors.JWTExpired,
    errors.JWTInvalid,
    errors.JWSInvalid,
    errors.JWSSignatureVerificationFailed,
    errors.JOSEAlgNotAllowed,
    errors.JWKSNoMatchingKey,
    errors.JWKSMultipleMatchingKeys,
]

export interface GoogleIdTokenClaims {
    /** Google's user id: the same value as userinfo's `id`, so an account
     * linked through the code-exchange flow is found again here. */
    sub: string
    email: string | null
    emailVerified: boolean
    name: string | null
    picture: string | null
}

/**
 * The token's claims when it is a valid Google ID token for `audience`, or
 * null when it is not (bad signature, wrong issuer/audience, expired,
 * malformed). Failing to REACH Google's key set is not a verdict on the
 * token: that throws, so the route reports a 500 instead of a 401.
 */
export async function verifyGoogleIdToken(
    idToken: string,
    audience: string,
): Promise<GoogleIdTokenClaims | null> {
    try {
        const { payload } = await jwtVerify(idToken, googleKeys, {
            issuer: GOOGLE_ISSUERS,
            audience,
        })
        if (typeof payload.sub !== 'string' || payload.sub === '') return null
        return {
            sub: payload.sub,
            email:
                typeof payload.email === 'string'
                    ? payload.email.toLowerCase().trim()
                    : null,
            emailVerified: payload.email_verified === true,
            name: typeof payload.name === 'string' ? payload.name : null,
            picture:
                typeof payload.picture === 'string' ? payload.picture : null,
        }
    } catch (error) {
        if (TOKEN_VERDICTS.some(verdict => error instanceof verdict)) {
            return null
        }
        throw error
    }
}
