/**
 * What a shopper is told when better-auth sends them back with `?error=<code>`.
 *
 * Better-auth reports every failed sign-in by REDIRECTING with the code in the
 * query string: Google/Apple failures (`state_mismatch`, `invalid_code`,
 * `account_not_linked`, …) and bad email-verification links (`TOKEN_EXPIRED`,
 * `INVALID_TOKEN`, …). Until this module existed, most of those codes landed
 * on `/?error=<code>` and nothing read them: the shopper clicked "Sign up with
 * Google", or their verification link, and was dropped on the homepage with no
 * word about what went wrong (PostHog, Aug-Sep 2026: 34 such landings, e.g. a
 * Yahoo Mail verification click answered with a silent `TOKEN_EXPIRED`).
 *
 * Codes arrive in both cases (the OAuth callback uses snake_case, the
 * email-verification route uses BASE_ERROR_CODES in UPPER_CASE), so they are
 * matched case-insensitively. Any code not listed still gets the generic
 * notice: an error in the URL is never ignored.
 */

export type AuthErrorNotice = {
    title: string
    body: string
    /** Where the one useful next step lives; null when the form below is it. */
    action: { label: string; href: string } | null
}

const REQUEST_NEW_LINK = { label: 'Request New Link', href: '/verify' }

const SOCIAL_SIGN_IN_INTERRUPTED: AuthErrorNotice = {
    title: 'Sign-in was interrupted',
    body: 'We could not match your Google or Apple sign-in to this browser. That happens when it was started in another tab or took too long. Please try again below.',
    action: null,
}

const SIGN_IN_FAILED: AuthErrorNotice = {
    title: 'Sign-in did not complete',
    body: 'Something went wrong while signing you in. Please try again, or sign in with your email and password below.',
    action: null,
}

const NOTICES: Record<string, AuthErrorNotice> = {
    token_expired: {
        title: 'Verification link expired',
        body: 'Your verification link has expired. Please request a new one to continue.',
        action: REQUEST_NEW_LINK,
    },
    invalid_token: {
        title: 'Verification link not valid',
        body: 'This verification link has already been used or was copied incompletely. Request a new one to continue.',
        action: REQUEST_NEW_LINK,
    },
    user_not_found: {
        title: 'Account not found',
        body: 'We could not find the account this link was sent for. Create your account again to get a fresh link.',
        action: { label: 'Create account', href: '/signup' },
    },
    // Better-auth refuses to attach Google/Apple to an email+password account
    // whose address was never verified (requireLocalEmailVerified), so the
    // only way forward is to finish that verification.
    account_not_linked: {
        title: 'Verify your email first',
        body: 'This email already has a Caramel account with a password, and it has not been verified yet. Verify it, then Google and Apple sign-in will work too. You can also sign in with your password.',
        action: { label: 'Send verification email', href: '/verify' },
    },
    access_denied: {
        title: 'Sign-in cancelled',
        body: 'The Google or Apple sign-in was cancelled, so nothing changed. Try again below whenever you are ready.',
        action: null,
    },
    email_not_found: {
        title: 'No email address shared',
        body: 'Your Google or Apple account did not share an email address with Caramel, and we need one for your account. Try again and allow email access, or sign up with your email.',
        action: null,
    },
    state_mismatch: SOCIAL_SIGN_IN_INTERRUPTED,
    state_not_found: SOCIAL_SIGN_IN_INTERRUPTED,
    state_invalid: SOCIAL_SIGN_IN_INTERRUPTED,
    state_security_mismatch: SOCIAL_SIGN_IN_INTERRUPTED,
    please_restart_the_process: SOCIAL_SIGN_IN_INTERRUPTED,
}

// `code` is the raw `error` search param, so it is an array when the key
// repeats (`?error=a&error=b`); the first value wins rather than crashing
// the page on `.trim()`.
export function describeAuthError(
    code: string | string[] | undefined,
): AuthErrorNotice | null {
    const first = Array.isArray(code) ? code[0] : code
    const normalized = first?.trim().toLowerCase()
    if (!normalized) return null
    return NOTICES[normalized] ?? SIGN_IN_FAILED
}
