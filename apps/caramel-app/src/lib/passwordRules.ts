/**
 * The password policy, in one place.
 *
 * It previously existed twice: as a yup schema in SignupPageClient and as a
 * hand-written checklist in PasswordChecker. They had already drifted — the
 * checklist ticked "minimum length reached" at 5 characters, and any change to
 * one copy silently left the other lying to the shopper. The reset-password
 * flow is a third consumer, so this is now the only definition.
 *
 * Raised 5 -> 8 characters with this consolidation. It applies to newly-set
 * passwords only (signup and reset); existing accounts are unaffected because
 * sign-in never re-validates against the policy.
 */

export const MIN_PASSWORD_LENGTH = 8

export const PASSWORD_UPPERCASE = /[A-Z]/
export const PASSWORD_NUMBER = /[0-9]/
export const PASSWORD_SPECIAL = /[!@#$%^&*+-]/

export type PasswordRule = {
    id: string
    test: (password: string) => boolean
    /** Shown in the checklist once satisfied. */
    success: string
    /** Shown in the checklist while unsatisfied, and as the form-level error. */
    failure: string
}

export const passwordRules: PasswordRule[] = [
    {
        id: 'length',
        test: password => password.length >= MIN_PASSWORD_LENGTH,
        success: `At least ${MIN_PASSWORD_LENGTH} characters`,
        failure: `Use at least ${MIN_PASSWORD_LENGTH} characters`,
    },
    {
        id: 'uppercase',
        test: password => PASSWORD_UPPERCASE.test(password),
        success: 'At least one uppercase letter',
        failure: 'Add at least one uppercase letter',
    },
    {
        id: 'number',
        test: password => PASSWORD_NUMBER.test(password),
        success: 'At least one number',
        failure: 'Add at least one number',
    },
    {
        id: 'special',
        test: password => PASSWORD_SPECIAL.test(password),
        success: 'At least one special character',
        failure: 'Add at least one special character (!@#$%^&*+-)',
    },
]

/** First unmet rule, or undefined when the password satisfies the policy. */
export function firstPasswordFailure(password: string): string | undefined {
    return passwordRules.find(rule => !rule.test(password))?.failure
}
