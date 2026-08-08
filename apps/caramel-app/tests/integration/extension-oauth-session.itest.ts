import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
    mintExtensionSessionForUser,
} from '@/lib/auth/extensionOAuthSession'
import prisma from '@/lib/prisma'
import { afterAll, describe, expect, it } from 'vitest'

// E-01 integration — the extension OAuth session mint (F-007,
// src/lib/auth/extensionOAuthSession.ts) exercised against the REAL prisma
// client + live local Postgres (:58005; the harness/CI runs `prisma migrate
// deploy` first, so users/accounts/sessions from the better_auth migration
// exist). The unit tests can only mock prisma, so they can't prove the part
// that actually matters here: on a SECOND sign-in with the same provider +
// provider-account-id, the mint must UPDATE the single existing account row
// (token refresh) rather than insert a duplicate — a behaviour enforced by the
// real @@unique([providerId, accountId]) constraint on `accounts`, which only a
// live DB has. It also pins NF-12 (the response reflects the FRESHLY-updated
// name/image, not the stale pre-update row).
//
// Everything created here uses a private, obviously-synthetic namespace that no
// seed row or other integration file touches, and is deleted in afterAll, so
// the suite is idempotent and re-runnable (fileParallelism is off — see
// vitest.integration.config.ts).
const UNIQUE = `e01-${Date.now()}`
const PROVIDER = 'google' as const
const PROVIDER_ACCOUNT_ID = `ext-oauth-itest-acct-${UNIQUE}`
const EMAIL = `ext-oauth-itest-${UNIQUE}@example.com`

afterAll(async () => {
    // Sessions/accounts cascade off the user, but delete explicitly + in FK
    // order so cleanup never depends on cascade config.
    const user = await prisma.user.findFirst({ where: { email: EMAIL } })
    if (user) {
        await prisma.session.deleteMany({ where: { userId: user.id } })
        await prisma.account.deleteMany({ where: { userId: user.id } })
        await prisma.user.delete({ where: { id: user.id } })
    }
})

describe('extension OAuth session mint (F-007) — real DB constraints', () => {
    it('re-auth updates the single account row (token refresh) and refreshes the minted profile, without duplicating the account', async () => {
        // ── First sign-in: creates user + account + session. ──────────────
        const first = await mintExtensionSession({
            provider: PROVIDER,
            providerUser: {
                id: PROVIDER_ACCOUNT_ID,
                email: EMAIL,
                name: 'First Name',
                image: 'https://example.com/first.png',
                emailVerified: true,
            },
            tokens: { accessToken: 'access-token-1', idToken: 'id-token-1' },
        })

        expect(first.token).toBeTruthy()
        expect(first.username).toBe('First Name')
        expect(first.image).toBe('https://example.com/first.png')

        const userAfterFirst = await prisma.user.findFirst({
            where: { email: EMAIL },
        })
        expect(userAfterFirst).not.toBeNull()
        expect(userAfterFirst?.emailVerified).toBe(true)

        const accountsAfterFirst = await prisma.account.findMany({
            where: {
                providerId: PROVIDER,
                accountId: PROVIDER_ACCOUNT_ID,
            },
        })
        expect(accountsAfterFirst).toHaveLength(1)
        expect(accountsAfterFirst[0].accessToken).toBe('access-token-1')
        expect(accountsAfterFirst[0].idToken).toBe('id-token-1')

        const sessionsAfterFirst = await prisma.session.findMany({
            where: { userId: userAfterFirst!.id },
        })
        expect(sessionsAfterFirst).toHaveLength(1)
        expect(sessionsAfterFirst[0].token).toBe(first.token)

        // ── Second sign-in (re-auth): SAME provider + provider-account-id,
        // fresh tokens + updated profile. Must reuse the user, UPDATE the one
        // account row, and add a new session. ────────────────────────────
        const second = await mintExtensionSession({
            provider: PROVIDER,
            providerUser: {
                id: PROVIDER_ACCOUNT_ID,
                email: EMAIL,
                name: 'Updated Name',
                image: 'https://example.com/updated.png',
                emailVerified: true,
            },
            tokens: { accessToken: 'access-token-2', idToken: 'id-token-2' },
        })

        // NF-12: the minted response reflects the just-updated name/image,
        // not the stale pre-update row.
        expect(second.username).toBe('Updated Name')
        expect(second.image).toBe('https://example.com/updated.png')
        expect(second.token).not.toBe(first.token)

        // Exactly ONE user — re-auth found the existing one by account link.
        const users = await prisma.user.findMany({ where: { email: EMAIL } })
        expect(users).toHaveLength(1)

        // Still exactly ONE account (the @@unique held) with REFRESHED tokens —
        // the update branch, provably not a duplicate insert.
        const accountsAfterSecond = await prisma.account.findMany({
            where: {
                providerId: PROVIDER,
                accountId: PROVIDER_ACCOUNT_ID,
            },
        })
        expect(accountsAfterSecond).toHaveLength(1)
        expect(accountsAfterSecond[0].id).toBe(accountsAfterFirst[0].id)
        expect(accountsAfterSecond[0].accessToken).toBe('access-token-2')
        expect(accountsAfterSecond[0].idToken).toBe('id-token-2')

        // Two sessions now — each mint issues a distinct 7-day session.
        const sessionsAfterSecond = await prisma.session.findMany({
            where: { userId: users[0].id },
        })
        expect(sessionsAfterSecond).toHaveLength(2)
    })

    it('mintExtensionSessionForUser (website→extension relay) issues a fresh session for an existing user and null for a missing one', async () => {
        // Reuses the user created by the re-auth test above (this suite runs
        // sequentially — fileParallelism off).
        const user = await prisma.user.findFirst({ where: { email: EMAIL } })
        expect(user).not.toBeNull()

        const sessionsBefore = await prisma.session.count({
            where: { userId: user!.id },
        })
        const relayed = await mintExtensionSessionForUser(user!.id)
        expect(relayed).not.toBeNull()
        expect(relayed!.token).toBeTruthy()
        expect(relayed!.username).toBe('Updated Name')

        // Same raw-token contract as the OAuth mint: a real Session row whose
        // token IS the returned bearer credential, ~7-day expiry.
        const row = await prisma.session.findFirst({
            where: { token: relayed!.token },
        })
        expect(row).not.toBeNull()
        expect(row!.userId).toBe(user!.id)
        expect(row!.expiresAt.getTime()).toBeGreaterThan(
            Date.now() + 6 * 24 * 60 * 60 * 1000,
        )
        expect(
            await prisma.session.count({ where: { userId: user!.id } }),
        ).toBe(sessionsBefore + 1)

        // Deleted-account-with-live-cookie edge: no throw, just null.
        expect(
            await mintExtensionSessionForUser(`missing-user-${UNIQUE}`),
        ).toBeNull()
    })

    it('throws ExtensionOAuthEmailRequiredError when no user exists and the provider gave no email', async () => {
        // Apple private-relay edge: no email + no pre-existing account link →
        // cannot create a user, must throw loudly (never a silent partial mint).
        await expect(
            mintExtensionSession({
                provider: 'apple',
                providerUser: {
                    id: `ext-oauth-itest-noemail-${UNIQUE}`,
                    email: null,
                },
                tokens: {},
            }),
        ).rejects.toBeInstanceOf(ExtensionOAuthEmailRequiredError)
    })
})
