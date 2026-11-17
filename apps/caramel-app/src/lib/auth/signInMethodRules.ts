/**
 * What /profile > "Sign-in methods" shows and allows (owner rule 2026-10-27:
 * same email = same account, and each person manages the ways into it).
 *
 * One row per way Caramel offers to sign in on the web: Google, Apple, and
 * email + password. A row is connected when the account has that login
 * (GET /api/account/sign-in-methods, which leaves out a password row whose
 * password a take-back cleared). Rules:
 *   - the LAST connected method can never be disconnected (better-auth
 *     refuses it too); the button stays visible, disabled, with the reason;
 *   - a missing provider gets Connect (better-auth `linkSocial`, a full-page
 *     redirect through the provider);
 *   - a missing password is set through "Forgot password", not here.
 *
 * Pure (no React, no auth client) so it is tested on its own.
 */

export type SocialSignInProvider = 'google' | 'apple'

/** The providers src/lib/auth/auth.ts offers, in display order. */
const SOCIAL_SIGN_IN_PROVIDERS: readonly SocialSignInProvider[] = [
    'google',
    'apple',
]
const SOCIAL_PROVIDER_IDS: ReadonlySet<string> = new Set(
    SOCIAL_SIGN_IN_PROVIDERS,
)

/** better-auth's provider id of the email + password login. */
const PASSWORD_PROVIDER_ID = 'credential'

export type SignInMethodRow = {
    id: string
    connected: boolean
    isPassword: boolean
    /** Connect is offered (a social provider that is not connected yet). */
    canConnect: boolean
    /** Disconnect is offered and allowed. */
    canDisconnect: boolean
    /** The only way in left: Disconnect stays visible, disabled, with the reason. */
    isLastMethod: boolean
}

export function signInMethodRows(
    linkedProviderIds: readonly string[],
): SignInMethodRow[] {
    const linked = new Set(
        linkedProviderIds
            .map(id => id.trim().toLowerCase())
            .filter(id => id.length > 0),
    )
    const offered = new Set<string>([
        ...SOCIAL_SIGN_IN_PROVIDERS,
        PASSWORD_PROVIDER_ID,
    ])
    // Any other provider the account carries counts as a way in too.
    const otherIds = Array.from(linked).filter(id => !offered.has(id))

    const rowFor = (id: string): SignInMethodRow => {
        const connected = linked.has(id)
        const isLastMethod = connected && linked.size <= 1
        return {
            id,
            connected,
            isPassword: id === PASSWORD_PROVIDER_ID,
            canConnect: SOCIAL_PROVIDER_IDS.has(id) && !connected,
            canDisconnect: connected && !isLastMethod,
            isLastMethod,
        }
    }

    return [
        ...SOCIAL_SIGN_IN_PROVIDERS.map(rowFor),
        rowFor(PASSWORD_PROVIDER_ID),
        ...otherIds.map(rowFor),
    ]
}

/** What a failed Connect's `?error=` code tells the person. */
export function connectErrorMessage(code: string): string {
    if (code === 'account_already_linked_to_different_user')
        return 'That account already signs in to a different Caramel account.'
    if (code === 'unable_to_link_account' || code === 'email_not_verified')
        return 'That account has no verified email address, so it could not be connected.'
    return 'That account could not be connected. Please try again.'
}

/**
 * What a refused Disconnect tells the person. better-auth only removes a
 * sign-in method from a session started in the last day (`SESSION_NOT_FRESH`).
 */
export function disconnectErrorMessage(
    code: string | undefined,
    providerLabel: string,
): string {
    if (code === 'SESSION_NOT_FRESH')
        return `For your security, sign out and back in, then disconnect ${providerLabel}.`
    if (code === 'FAILED_TO_UNLINK_LAST_ACCOUNT')
        return 'This is your only way to sign in, so it cannot be disconnected.'
    return `${providerLabel} could not be disconnected. Please try again.`
}
