'use client'

import { BASE_URL } from '@/lib/env.client'
import { inferAdditionalFields } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import type { auth } from './auth'

export const authClient = createAuthClient({
    baseURL: BASE_URL,
    plugins: [inferAdditionalFields<typeof auth>()],
})

export const signIn = {
    email: authClient.signIn.email,
    social: authClient.signIn.social,
}

export const signUp = authClient.signUp
export const signOut = authClient.signOut
export const useSession = authClient.useSession

/** Sends the reset email. Named `forgetPassword` in older Better Auth; this
 *  project is pinned to 1.6.23, where the endpoint is /request-password-reset. */
export const requestPasswordReset = authClient.requestPasswordReset
/** Consumes the token from that email and sets the new password. */
export const resetPassword = authClient.resetPassword
