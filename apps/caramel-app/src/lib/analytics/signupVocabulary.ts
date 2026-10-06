// src/lib/analytics/signupVocabulary.ts
//
// The signup vocabulary shared by the browser (`signup_started`) and the
// server (`signup_completed`, `users.acquisition`). One definition, so the
// funnel's two ends cannot name the same method differently.

/** The ways to create an account. */
export const SIGNUP_METHODS = ['email', 'google', 'apple'] as const
export type SignupMethod = (typeof SIGNUP_METHODS)[number]

/** Where the account was created: the website or the browser extension. */
export const SIGNUP_SURFACES = ['web', 'extension'] as const
export type SignupSurface = (typeof SIGNUP_SURFACES)[number]

export function isSignupMethod(value: unknown): value is SignupMethod {
    return (
        typeof value === 'string' &&
        (SIGNUP_METHODS as readonly string[]).includes(value)
    )
}
