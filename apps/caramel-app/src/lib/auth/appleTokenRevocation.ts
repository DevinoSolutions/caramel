// Sign in with Apple token revocation on account deletion — the second half of
// App Review guideline 5.1.1(v) (T-5065): an app that offers Sign in with Apple
// must revoke the user's Apple tokens through the REST API when the account is
// deleted, so the app also disappears from the person's "Sign in with Apple"
// list in their Apple ID settings.
//   https://developer.apple.com/documentation/sign_in_with_apple/revoke_tokens
//
// Where the tokens come from: the `accounts` row for provider 'apple'. Both
// Apple code exchanges persist them there — better-auth's web callback (it
// stores access + refresh token, encrypted via `account.encryptOAuthTokens`)
// and the extension/app mint (extensionOAuthSession.ts). /auth/revoke needs
// the client the grant was issued to: APPLE_CLIENT_ID (the Services ID) for
// every web flow, the iOS bundle id for the app's native sheet
// (appleNativeSignIn.ts). The row's identity token is stored with the grant
// it came from, so its `aud` names that client.
//
// The deletion cascades the accounts away, so the tokens are LOADED first
// (loadAppleRevocationTargets) and REVOKED after the delete commits
// (revokeAppleGrants). A failed revoke never un-deletes the account and never
// fails the request, but it is never silent either: it goes to Sentry with a
// reason and is reported back to the caller as `failed`.
import 'server-only'

import * as Sentry from '@sentry/nextjs'

import { getAppleClientSecret } from '@/lib/auth/appleClientSecret'
import { APPLE_NATIVE_APP_CLIENT_ID } from '@/lib/auth/appleNativeSignIn'
import { decryptOAuthToken } from '@/lib/auth/oauthTokenCrypto'
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'

export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke'
/** Apple answers in well under a second; this only bounds a hung connection,
 * since the delete request is waiting on it after the commit. */
const APPLE_REVOKE_TIMEOUT_MS = 10_000

/** `not_applicable`: the user has no Apple account, no call was made.
 * `revoked`: Apple accepted the revoke for every Apple account the user had.
 * `failed`: at least one revoke did not succeed (already in Sentry). */
export type AppleRevocationOutcome = 'not_applicable' | 'revoked' | 'failed'

/** The still-stored (possibly encrypted) tokens of one Apple account row. */
export interface AppleRevocationTarget {
    refreshToken: string | null
    accessToken: string | null
    /** Plain text, as both mints store it; only its `aud` is read. */
    idToken: string | null
}

type AppleTokenTypeHint = 'refresh_token' | 'access_token'

/** Read BEFORE the user delete: the accounts cascade away with the user. */
export async function loadAppleRevocationTargets(
    userId: string,
): Promise<AppleRevocationTarget[]> {
    return prisma.account.findMany({
        where: { userId, providerId: 'apple' },
        select: { refreshToken: true, accessToken: true, idToken: true },
    })
}

/** The client the stored grant belongs to: the iOS bundle id when the row's
 * identity token was issued to it, the Services ID otherwise (every web
 * flow, and rows from before the id token was read here). Our own stored
 * token, not a credential being checked, so its payload is read unverified. */
function grantClientId(idToken: string | null): string | undefined {
    const payload = idToken?.split('.')[1]
    if (payload) {
        try {
            const claims: unknown = JSON.parse(
                Buffer.from(payload, 'base64url').toString('utf8'),
            )
            if (
                typeof claims === 'object' &&
                claims !== null &&
                'aud' in claims &&
                claims.aud === APPLE_NATIVE_APP_CLIENT_ID
            ) {
                return APPLE_NATIVE_APP_CLIENT_ID
            }
        } catch {
            // Not a JWT we can read: the grant is a web flow's, as before.
        }
    }
    return env.APPLE_CLIENT_ID
}

/** Apple's failure body is `{"error": "invalid_client"}`-shaped; the code is
 * enough to act on and carries no token or user data. */
function appleErrorCode(body: string): string {
    try {
        const parsed: unknown = JSON.parse(body)
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'error' in parsed &&
            typeof parsed.error === 'string'
        ) {
            return parsed.error
        }
        return 'no_error_field'
    } catch {
        return 'unparseable_body'
    }
}

function reportRevocationFailure(
    reason: string,
    extra: Record<string, string | number>,
): void {
    const error = new Error(`Apple token revocation failed: ${reason}`)
    error.name = 'AppleTokenRevocationError'
    // Tags and extras are reasons, status codes and library error messages
    // only: no token, no user id, no email (the user row is already gone).
    Sentry.captureException(error, {
        level: 'error',
        tags: { route: 'account/delete', provider: 'apple', reason },
        extra,
    })
}

/** Revoke one Apple account's grant. Returns whether Apple accepted it. */
async function revokeOne(target: AppleRevocationTarget): Promise<boolean> {
    // The refresh token revokes the whole grant; the access token is the
    // fallback for a row that never stored one (the pre-T-5065 extension mint).
    const hint: AppleTokenTypeHint | null = target.refreshToken
        ? 'refresh_token'
        : target.accessToken
          ? 'access_token'
          : null
    const stored = target.refreshToken ?? target.accessToken
    if (!hint || !stored) {
        reportRevocationFailure('no_token_stored', {})
        return false
    }

    // Revoking needs Apple configured even for an app grant: no
    // APPLE_CLIENT_ID means no Apple sign-in and no key to sign with.
    const clientId = env.APPLE_CLIENT_ID
        ? grantClientId(target.idToken)
        : undefined
    if (!clientId) {
        reportRevocationFailure('apple_not_configured', { hint })
        return false
    }

    let response: Response
    let failureBody = ''
    try {
        const token = await decryptOAuthToken(stored)
        response = await fetch(APPLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: getAppleClientSecret(clientId),
                token,
                token_type_hint: hint,
            }),
            signal: AbortSignal.timeout(APPLE_REVOKE_TIMEOUT_MS),
        })
        if (!response.ok) failureBody = await response.text()
    } catch (cause) {
        // decrypt, secret signing or transport failed: reported, not swallowed.
        reportRevocationFailure('request_not_completed', {
            hint,
            cause: cause instanceof Error ? cause.message : String(cause),
        })
        return false
    }

    if (response.ok) return true

    reportRevocationFailure('apple_rejected', {
        hint,
        status: response.status,
        appleError: appleErrorCode(failureBody),
    })
    return false
}

/**
 * Revoke every Apple grant in `targets` (call AFTER the delete committed).
 * Never throws: each failure is captured in Sentry and folds into `failed`.
 */
export async function revokeAppleGrants(
    targets: readonly AppleRevocationTarget[],
): Promise<AppleRevocationOutcome> {
    if (targets.length === 0) return 'not_applicable'
    const results = await Promise.all(targets.map(revokeOne))
    return results.every(Boolean) ? 'revoked' : 'failed'
}
