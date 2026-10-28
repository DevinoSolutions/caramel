// Same email = same account, whatever the sign-in method (owner rule
// 2026-10-27). A Google or Apple sign-in whose provider-VERIFIED address
// matches an existing user links to that user, including a user whose own
// address was never verified (a password signup that never clicked its link).
// Better Auth refuses that case by default (`requireLocalEmailVerified`); the
// web Google/Apple callback now links, and this module keeps the protection
// the refusal gave. (The extension's own OAuth mint, extensionOAuthSession.ts,
// already linked by verified email and takes such an account back itself.)
//
// `trustedProviders` stays empty: a trusted provider is linked WITHOUT
// checking the identity token's `email_verified` claim, so every provider
// links only on its own `email_verified`.
//
// Anyone can register any address with a password, so an unverified user may
// be a squatter's. Once the provider proves the address belongs to someone
// else, linking into that row as it stands would leave the squatter's password
// working on the real owner's account. So, BEFORE the new identity row is
// written:
//   - every session of that user is revoked (the sign-in's own session is
//     minted afterwards, so it is the only one left);
//   - the password is cleared (the login row is kept, its password set to
//     null), so whoever set it can no longer sign in with it; the owner sets a
//     new one through the emailed reset, which proves the address and fills
//     the same row.
// Better Auth then marks the address verified (oauth2/link-account.mjs).
//
// It does nothing when the row being written IS the password login, when the
// address is already verified, or when the request is signed in AS that user
// (an explicit Connect from Settings: the session holder is the one linking).
// A failure throws: a take-back that did not happen must not end in a link.

import type { BetterAuthOptions } from 'better-auth'
import { getSessionFromCtx } from 'better-auth/api'

type AccountCreateBefore = NonNullable<
    NonNullable<
        NonNullable<BetterAuthOptions['databaseHooks']>['account']
    >['create']
>['before']

type NewAccountRow = Parameters<NonNullable<AccountCreateBefore>>[0]
type HookContext = NonNullable<Parameters<NonNullable<AccountCreateBefore>>[1]>

/** The reserved Better Auth provider id of the email + password login. */
const CREDENTIAL_PROVIDER_ID = 'credential'

/**
 * Link on the provider's own `email_verified` (never a trusted-provider
 * override), into verified and unverified local rows alike; an explicit
 * Connect may name a different address (Apple Hide My Email relays).
 */
export const ACCOUNT_LINKING = {
    enabled: true,
    trustedProviders: [],
    requireLocalEmailVerified: false,
    allowDifferentEmails: true,
} satisfies NonNullable<
    NonNullable<BetterAuthOptions['account']>['accountLinking']
>

export type UnverifiedAccountTakenBack = {
    userId: string
    /** The provider whose verified address proved ownership. */
    providerId: string
    sessionsRevoked: number
    /** A password was set on the account and has been cleared. */
    passwordRemoved: boolean
}

/** Pure: does writing this identity row take an unverified account back? */
export function takesUnverifiedAccountBack(input: {
    providerId: string
    userEmailVerified: boolean
    requestSignedInAsUser: boolean
}): boolean {
    if (input.providerId === CREDENTIAL_PROVIDER_ID) return false
    if (input.userEmailVerified) return false
    return !input.requestSignedInAsUser
}

async function requestSignedInAs(
    context: HookContext,
    userId: string,
): Promise<boolean> {
    // Server-side calls with no request (a script, a test) carry no session.
    if (!context.headers && !context.request) return false
    const session = await getSessionFromCtx(context, { disableRefresh: true })
    return session?.user.id === userId
}

/**
 * The `account.create.before` database hook. `report` is told about every
 * take-back (production: Sentry + log; tests: a list).
 */
export function unverifiedAccountTakeBack(
    report: (event: UnverifiedAccountTakenBack) => void,
) {
    return async (account: NewAccountRow, context?: HookContext | null) => {
        if (account.providerId === CREDENTIAL_PROVIDER_ID || !context) return
        const adapter = context.context.internalAdapter
        const user = await adapter.findUserById(account.userId)
        if (!user) return
        const takeBack = takesUnverifiedAccountBack({
            providerId: account.providerId,
            userEmailVerified: user.emailVerified,
            requestSignedInAsUser: user.emailVerified
                ? false
                : await requestSignedInAs(context, user.id),
        })
        if (!takeBack) return

        const sessions = await adapter.listSessions(user.id)
        await adapter.deleteUserSessions(user.id)
        const passwordLogins = (await adapter.findAccounts(user.id)).filter(
            row => row.providerId === CREDENTIAL_PROVIDER_ID && row.password,
        )
        // Kept, not deleted (orchestrator decision 2026-10-27): no account data is removed, and a
        // password reset fills this same row again.
        for (const row of passwordLogins)
            await adapter.updateAccount(row.id, { password: null })

        report({
            userId: user.id,
            providerId: account.providerId,
            sessionsRevoked: sessions.length,
            passwordRemoved: passwordLogins.length > 0,
        })
    }
}
