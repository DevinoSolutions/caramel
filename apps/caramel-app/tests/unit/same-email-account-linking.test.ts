// Same email = same account, whatever the sign-in method (owner rule
// 2026-10-27). Pinned through a REAL Better Auth instance (in-memory adapter,
// the production linking policy and the production take-back hook). Only the
// providers are replaced: `verifyIdToken` / `getUserInfo` below stand in for
// Google's and Apple's id-token verification, so nothing here calls Google,
// Apple or the database.
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { APIError } from 'better-auth/api'
import { describe, expect, it } from 'vitest'

import {
    ACCOUNT_LINKING,
    takesUnverifiedAccountBack,
    unverifiedAccountTakeBack,
    type UnverifiedAccountTakenBack,
} from '@/lib/auth/accountLinking'

const EMAIL = 'person@example.com'
const RELAY_EMAIL = 'x7k2q9@privaterelay.appleid.com'
const PASSWORD = 'a-long-enough-test-password'

type MemoryRow = Record<string, unknown>
type MemoryDb = Record<
    'user' | 'session' | 'account' | 'verification',
    MemoryRow[]
>
type Identity = { email: string; emailVerified: boolean }

function emptyDb(): MemoryDb {
    return { user: [], session: [], account: [], verification: [] }
}

/**
 * Any token verifies and names `subject` at `identity()`. The return is cast
 * because the provider types demand a full Google/Apple profile; Better Auth
 * 1.7 reads only `sub` from it (the account key).
 */
function stubProvider(subject: string, identity: () => Identity) {
    return {
        verifyIdToken: async () => true,
        getUserInfo: async () =>
            ({
                user: { name: 'Pat Person', ...identity() },
                data: { sub: subject },
            }) as never,
    }
}

function buildAuth(db: MemoryDb) {
    const identities: Record<'google' | 'apple', Identity> = {
        google: { email: EMAIL, emailVerified: true },
        apple: { email: EMAIL, emailVerified: true },
    }
    const takenBack: UnverifiedAccountTakenBack[] = []
    const sentResetUrls: string[] = []
    const auth = betterAuth({
        baseURL: 'http://localhost:3000',
        secret: 'same-email-account-linking-test-secret-0123456789',
        database: memoryAdapter(db),
        emailAndPassword: {
            enabled: true,
            sendResetPassword: async ({ url }) => {
                sentResetUrls.push(url)
            },
        },
        socialProviders: {
            google: {
                clientId: 'web-client-id.apps.googleusercontent.com',
                clientSecret: 'unused-by-the-id-token-path',
                ...stubProvider('google-subject-1', () => identities.google),
            },
            apple: {
                clientId: 'com.example.web',
                clientSecret: 'unused-by-the-id-token-path',
                ...stubProvider('apple-subject-1', () => identities.apple),
            },
        },
        account: { accountLinking: ACCOUNT_LINKING },
        databaseHooks: {
            account: {
                create: {
                    before: unverifiedAccountTakeBack(event => {
                        takenBack.push(event)
                    }),
                },
            },
        },
    })
    return { auth, identities, takenBack, sentResetUrls }
}

type TestAuth = ReturnType<typeof buildAuth>['auth']

async function providerSignIn(auth: TestAuth, provider: 'google' | 'apple') {
    const result = await auth.api.signInSocial({
        body: { provider, idToken: { token: `stub-${provider}-id-token` } },
    })
    if (!('user' in result))
        throw new Error('an id-token sign-in answers with its user')
    return result
}

async function passwordSignUp(auth: TestAuth) {
    const { headers, response } = await auth.api.signUpEmail({
        body: { email: EMAIL, password: PASSWORD, name: 'Squatter Or Owner' },
        returnHeaders: true,
    })
    const cookie = headers.get('set-cookie')
    if (!cookie) throw new Error('a signup sets its session cookie')
    return { userId: response.user.id, cookie: cookie.split(';')[0] ?? '' }
}

const rowsOf = (db: MemoryDb, providerId: string) =>
    db.account.filter(row => row.providerId === providerId)

function userRow(db: MemoryDb, userId: string) {
    const row = db.user.find(user => user.id === userId)
    if (!row) throw new Error(`no user ${userId}`)
    return row
}

describe('takesUnverifiedAccountBack', () => {
    it('takes back only an unverified account linked by someone not signed in as it', () => {
        const base = {
            providerId: 'google',
            userEmailVerified: false,
            userHasOtherIdentities: true,
            requestSignedInAsUser: false,
        }
        expect(takesUnverifiedAccountBack(base)).toBe(true)
        expect(
            takesUnverifiedAccountBack({ ...base, userEmailVerified: true }),
        ).toBe(false)
        expect(
            takesUnverifiedAccountBack({
                ...base,
                requestSignedInAsUser: true,
            }),
        ).toBe(false)
        expect(
            takesUnverifiedAccountBack({ ...base, providerId: 'credential' }),
        ).toBe(false)
        expect(
            takesUnverifiedAccountBack({
                ...base,
                userHasOtherIdentities: false,
            }),
        ).toBe(false)
    })
})

describe('same email, any sign-in method, one account (real Better Auth)', () => {
    it('Apple then Google at the same address is one user with both identities', async () => {
        const db = emptyDb()
        const { auth } = buildAuth(db)
        const apple = await providerSignIn(auth, 'apple')
        const google = await providerSignIn(auth, 'google')
        expect(google.user.id).toBe(apple.user.id)
        expect(db.user).toHaveLength(1)
        expect(rowsOf(db, 'apple')).toHaveLength(1)
        expect(rowsOf(db, 'google')).toHaveLength(1)
    })

    it('a first sign-in whose provider does not vouch for the address is a sign-up, not a take-back', async () => {
        const db = emptyDb()
        const { auth, identities, takenBack } = buildAuth(db)
        identities.google = { email: EMAIL, emailVerified: false }

        await providerSignIn(auth, 'google')

        expect(db.user).toHaveLength(1)
        expect(rowsOf(db, 'google')).toHaveLength(1)
        expect(takenBack).toEqual([])
    })

    it('Google then Apple at the same address is one user with both identities', async () => {
        const db = emptyDb()
        const { auth } = buildAuth(db)
        const google = await providerSignIn(auth, 'google')
        const apple = await providerSignIn(auth, 'apple')
        expect(apple.user.id).toBe(google.user.id)
        expect(db.user).toHaveLength(1)
    })

    it('a verified password account gains Google and keeps its password and sessions', async () => {
        const db = emptyDb()
        const { auth, takenBack } = buildAuth(db)
        const owner = await passwordSignUp(auth)
        userRow(db, owner.userId).emailVerified = true
        const sessionsBefore = db.session.length

        const google = await providerSignIn(auth, 'google')

        expect(google.user.id).toBe(owner.userId)
        expect(rowsOf(db, 'credential')).toHaveLength(1)
        expect(db.session).toHaveLength(sessionsBefore + 1)
        expect(takenBack).toEqual([])
    })

    it('an unverified password account is taken back: linked, verified, its sessions and password gone', async () => {
        const db = emptyDb()
        const { auth, takenBack } = buildAuth(db)
        const squatter = await passwordSignUp(auth)
        expect(userRow(db, squatter.userId).emailVerified).toBe(false)
        const squatterSessions = db.session.map(row => row.id)
        expect(squatterSessions.length).toBeGreaterThan(0)

        const google = await providerSignIn(auth, 'google')

        expect(google.user.id).toBe(squatter.userId)
        expect(userRow(db, squatter.userId).emailVerified).toBe(true)
        // The password login row is kept with its password cleared, never deleted.
        const passwordRows = rowsOf(db, 'credential')
        expect(passwordRows).toHaveLength(1)
        expect(passwordRows[0]?.password ?? null).toBeNull()
        expect(db.session.map(row => row.id)).not.toEqual(
            expect.arrayContaining(squatterSessions),
        )
        expect(db.session).toHaveLength(1)
        await expect(
            auth.api.signInEmail({
                body: { email: EMAIL, password: PASSWORD },
            }),
        ).rejects.toThrow()
        expect(takenBack).toEqual([
            {
                userId: squatter.userId,
                providerId: 'google',
                sessionsRevoked: squatterSessions.length,
                passwordRemoved: true,
            },
        ])
    })

    it('an Apple sign-in takes an unverified account back the same way', async () => {
        const db = emptyDb()
        const { auth, takenBack } = buildAuth(db)
        const squatter = await passwordSignUp(auth)

        const apple = await providerSignIn(auth, 'apple')

        expect(apple.user.id).toBe(squatter.userId)
        expect(rowsOf(db, 'credential')[0]?.password ?? null).toBeNull()
        expect(takenBack).toHaveLength(1)
    })

    it('after a take-back the real owner can still set a password through the emailed reset', async () => {
        const db = emptyDb()
        const { auth, sentResetUrls } = buildAuth(db)
        await passwordSignUp(auth)
        const google = await providerSignIn(auth, 'google')

        await auth.api.requestPasswordReset({
            body: { email: EMAIL, redirectTo: '/reset' },
        })
        const token = sentResetUrls[sentResetUrls.length - 1]
            ?.split('/reset-password/')[1]
            ?.split('?')[0]
        if (!token) throw new Error('the reset email carries its token')
        await auth.api.resetPassword({
            body: { token, newPassword: 'the-owners-new-password' },
        })

        expect(rowsOf(db, 'credential')).toHaveLength(1)
        const signedIn = await auth.api.signInEmail({
            body: { email: EMAIL, password: 'the-owners-new-password' },
        })
        expect(signedIn.user.id).toBe(google.user.id)
        await expect(
            auth.api.signInEmail({
                body: { email: EMAIL, password: PASSWORD },
            }),
        ).rejects.toThrow()
    })

    it('a provider that does not vouch for the address never links', async () => {
        const db = emptyDb()
        const { auth, identities, takenBack } = buildAuth(db)
        const owner = await passwordSignUp(auth)
        userRow(db, owner.userId).emailVerified = true
        identities.google = { email: EMAIL, emailVerified: false }
        const sessionsBefore = db.session.length

        await expect(providerSignIn(auth, 'google')).rejects.toBeInstanceOf(
            APIError,
        )

        expect(rowsOf(db, 'google')).toHaveLength(0)
        expect(db.user).toHaveLength(1)
        expect(rowsOf(db, 'credential')).toHaveLength(1)
        expect(db.session).toHaveLength(sessionsBefore)
        expect(takenBack).toEqual([])
    })

    it("a signed-in user's explicit Connect links an Apple relay address and takes nothing away", async () => {
        const db = emptyDb()
        const { auth, identities, takenBack } = buildAuth(db)
        const owner = await passwordSignUp(auth)
        identities.apple = { email: RELAY_EMAIL, emailVerified: true }
        const sessionsBefore = db.session.map(row => row.id)

        await auth.api.linkSocialAccount({
            body: {
                provider: 'apple',
                idToken: { token: 'stub-apple-id-token' },
            },
            headers: new Headers({ cookie: owner.cookie }),
        })

        const apple = rowsOf(db, 'apple')
        expect(apple).toHaveLength(1)
        expect(apple[0]?.userId).toBe(owner.userId)
        expect(rowsOf(db, 'credential')).toHaveLength(1)
        expect(db.session.map(row => row.id)).toEqual(sessionsBefore)
        expect(takenBack).toEqual([])

        const relaySignIn = await providerSignIn(auth, 'apple')
        expect(relaySignIn.user.id).toBe(owner.userId)
    })
})
