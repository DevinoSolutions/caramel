'use client'

import { resetPosthogIdentity } from '@/lib/analytics/identity'
import { signOut } from '@/lib/auth/client'
import * as Sentry from '@sentry/nextjs'

/**
 * The one way the browser ends a session: clears the analytics identity, then
 * the better-auth session. Shared by the header's "Sign out" and by pages that
 * discover the server no longer honours the session cookie (the profile
 * overview's 401), so both leave the client in the same state.
 *
 * Callers navigate afterwards, whatever the result: a failed sign-out call
 * must not strand someone on a page that cannot work. The failure is reported
 * here, never swallowed, and returned so a caller that cares can act on it.
 *
 * @returns true when the session was cleared, false when the sign-out request
 * failed (already reported to Sentry).
 */
export async function endClientSession(): Promise<boolean> {
    // Clear the PostHog identity BEFORE the session goes away so the reset
    // isn't attributed to the logged-in person.
    resetPosthogIdentity()
    try {
        const result = await signOut()
        if (result.error) {
            Sentry.captureException(
                new Error(
                    `Sign-out failed with ${result.error.status}: ${result.error.message ?? result.error.statusText}`,
                ),
                { tags: { operation: 'client_sign_out' } },
            )
            return false
        }
        return true
    } catch (error) {
        Sentry.captureException(error, {
            tags: { operation: 'client_sign_out' },
        })
        return false
    }
}
