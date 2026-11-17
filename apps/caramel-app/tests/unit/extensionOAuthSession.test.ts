import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
import { decryptOAuthToken } from '@/lib/auth/oauthTokenCrypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F-007 — extensionOAuthSession unit tests (PLAN-F-007.md §Test
// strategy): google+apple both drive the SAME mintExtensionSession() and
// produce the output the pre-refactor route's two hand-rolled branches
// each produced independently. route-pipeline.test.ts exercises this
// through the real POST /api/extension/oauth handler (HTTP-level,
// end-to-end); this file exercises the module directly (unit-level),
// covering shapes route-pipeline.test.ts doesn't (e.g. account-token
// refresh on re-auth). The token every mint returns is the RAW session
// token — the module's dead bearer self-fetch was deleted (NF-07), so
// there is no fetch anywhere in the mint. (The only env read is the auth
// secret oauthTokenCrypto.ts encrypts the stored access/refresh tokens with;
// vitest.config.ts supplies BETTER_AUTH_SECRET and the REAL crypto runs here.)

const { prismaMock, prismaState } = vi.hoisted(() => {
    const prismaState = {
        existingUser: null as Record<string, unknown> | null,
        existingAccount: null as Record<string, unknown> | null,
    }
    const prismaMock = {
        user: {
            findFirst: vi.fn(async () => prismaState.existingUser),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-user-id',
                    username: null,
                    ...data,
                }),
            ),
            update: vi.fn(
                async ({
                    where,
                    data,
                }: {
                    where: { id: string }
                    data: Record<string, unknown>
                }) => ({ ...prismaState.existingUser, id: where.id, ...data }),
            ),
        },
        account: {
            findUnique: vi.fn(async () => prismaState.existingAccount),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-account-id',
                    ...data,
                }),
            ),
            update: vi.fn(
                async ({
                    where,
                    data,
                }: {
                    where: { id: string }
                    data: Record<string, unknown>
                }) => ({ id: where.id, ...data }),
            ),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        session: {
            deleteMany: vi.fn(async () => ({ count: 1 })),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-session-id',
                    ...data,
                }),
            ),
        },
    }
    return { prismaMock, prismaState }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

// TEST DOUBLE for the signup analytics step (its own behaviour is pinned in
// signup-capture.test.ts). Here we only assert the mint CALLS it for a brand
// new user — the mint bypasses better-auth's user.create hook, so this call is
// the only thing that records an extension signup.
const { recordSignupMock } = vi.hoisted(() => ({
    recordSignupMock: vi.fn(async () => ({
        acquisitionSaved: true,
        eventCaptured: true,
        aliased: false,
    })),
}))
vi.mock('@/lib/auth/signupCapture', () => ({ recordSignup: recordSignupMock }))

beforeEach(() => {
    recordSignupMock.mockClear()
    prismaState.existingUser = null
    prismaState.existingAccount = null
    for (const fn of [
        prismaMock.user.findFirst,
        prismaMock.user.create,
        prismaMock.user.update,
        prismaMock.account.findUnique,
        prismaMock.account.create,
        prismaMock.account.update,
        prismaMock.account.updateMany,
        prismaMock.session.create,
        prismaMock.session.deleteMany,
    ]) {
        fn.mockClear()
    }
    prismaMock.user.findFirst.mockImplementation(
        async () => prismaState.existingUser,
    )
})

describe('mintExtensionSession — google and apple produce the SAME shape (the finding: no per-provider divergence)', () => {
    it.each([
        {
            provider: 'google' as const,
            providerUser: {
                id: 'google-id-1',
                email: 'google-user@example.com',
                name: 'Google User',
                image: 'https://example.com/g.png',
                emailVerified: true,
            },
        },
        {
            provider: 'apple' as const,
            providerUser: {
                id: 'apple-id-1',
                email: 'apple-user@example.com',
                name: null,
                image: null,
                emailVerified: true,
            },
        },
    ])(
        '$provider: brand-new user -> creates user+account+session once, returns {token,username,image}',
        async ({ provider, providerUser }) => {
            const result = await mintExtensionSession({
                provider,
                providerUser,
                tokens: { accessToken: 'at', idToken: 'it' },
            })

            // The mint returns the RAW session token — exactly the token it
            // wrote to the Session row (NF-07: no bearer self-fetch exists).
            expect(result.token).toBe(
                prismaMock.session.create.mock.calls[0][0].data.token,
            )
            expect(result.username).toBe(
                providerUser.name ?? providerUser.email,
            )
            expect(result.image).toBe(providerUser.image)

            expect(prismaMock.user.create).toHaveBeenCalledTimes(1)
            expect(prismaMock.user.create.mock.calls[0][0].data).toEqual({
                email: providerUser.email,
                name: providerUser.name ?? null,
                image: providerUser.image ?? null,
                emailVerified: true,
                status: 'ACTIVE_USER',
            })
            expect(prismaMock.account.create).toHaveBeenCalledTimes(1)
            const created = prismaMock.account.create.mock.calls[0][0].data
            expect(created).toEqual({
                providerId: provider,
                accountId: providerUser.id,
                userId: 'new-user-id',
                accessToken: expect.any(String),
                refreshToken: null,
                idToken: 'it',
            })
            // Access token is encrypted at rest, never stored as handed over.
            expect(created.accessToken).not.toBe('at')
            expect(await decryptOAuthToken(created.accessToken as string)).toBe(
                'at',
            )
            expect(prismaMock.session.create).toHaveBeenCalledTimes(1)
            expect(prismaMock.session.create.mock.calls[0][0].data.userId).toBe(
                'new-user-id',
            )

            // A brand-new account is a signup: recorded once, as an extension
            // signup via this provider, with no request headers to read.
            expect(recordSignupMock).toHaveBeenCalledTimes(1)
            expect(recordSignupMock).toHaveBeenCalledWith({
                user: expect.objectContaining({ id: 'new-user-id' }),
                headers: null,
                method: provider,
                surface: 'extension',
                // No attribution passed (an old build): nothing to hand on.
                firstTouch: null,
                installId: null,
            })
        },
    )

    it("hands the extension's install id and first-touch record to recordSignup when the mint creates the user", async () => {
        const firstTouch = {
            utm_source: 'reddit',
            landing_path: '/',
            captured_at: '2026-10-01T12:00:00.000Z',
        }
        await mintExtensionSession({
            provider: 'google',
            providerUser: {
                id: 'google-id-2',
                email: 'attributed@example.com',
                name: 'Attributed',
                emailVerified: true,
            },
            tokens: { accessToken: 'at', idToken: 'it' },
            attribution: {
                installId: '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01',
                firstTouch,
            },
        })

        expect(recordSignupMock).toHaveBeenCalledTimes(1)
        expect(recordSignupMock).toHaveBeenCalledWith({
            user: expect.objectContaining({
                id: 'new-user-id',
                email: 'attributed@example.com',
            }),
            headers: null,
            method: 'google',
            surface: 'extension',
            firstTouch,
            installId: '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01',
        })
    })

    it('an existing user signing in is not a signup: attribution is ignored', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'back@example.com',
            name: 'Back',
            username: null,
            image: null,
            emailVerified: true,
        }
        await mintExtensionSession({
            provider: 'google',
            providerUser: {
                id: 'google-id-3',
                email: 'back@example.com',
                emailVerified: true,
            },
            tokens: {},
            attribution: {
                installId: '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01',
                firstTouch: null,
            },
        })
        expect(recordSignupMock).not.toHaveBeenCalled()
    })

    it.each(['google', 'apple'] as const)(
        '%s: existing account -> updates tokens instead of creating a new account link',
        async provider => {
            prismaState.existingUser = {
                id: 'existing-user-id',
                email: 'user@example.com',
                name: 'Existing',
                username: null,
                image: null,
                emailVerified: true,
            }
            prismaState.existingAccount = {
                id: 'existing-account-id',
                accessToken: 'old-at',
                idToken: 'old-it',
            }

            await mintExtensionSession({
                provider,
                providerUser: {
                    id: 'provider-user-id',
                    email: 'user@example.com',
                    emailVerified: true,
                },
                tokens: { accessToken: 'new-at', idToken: 'new-it' },
            })

            expect(prismaMock.account.create).not.toHaveBeenCalled()
            expect(prismaMock.account.update).toHaveBeenCalledTimes(1)
            const update = prismaMock.account.update.mock.calls[0][0]
            expect(update.where).toEqual({ id: 'existing-account-id' })
            expect(update.data.idToken).toBe('new-it')
            expect(update.data.accessToken).not.toBe('new-at')
            expect(
                await decryptOAuthToken(update.data.accessToken as string),
            ).toBe('new-at')
        },
    )
})

describe('mintExtensionSession — Apple refresh token persisted for revocation (T-5065)', () => {
    const providerUser = {
        id: 'apple-id-1',
        email: 'apple-user@example.com',
        emailVerified: true,
    }

    it('a new account stores the refresh token ENCRYPTED, so account deletion can revoke it', async () => {
        await mintExtensionSession({
            provider: 'apple',
            providerUser,
            tokens: {
                accessToken: 'at',
                refreshToken: 'r.apple-refresh.0.abc',
                idToken: 'it',
            },
        })

        const created = prismaMock.account.create.mock.calls[0][0].data
        expect(created.refreshToken).toEqual(expect.any(String))
        expect(created.refreshToken).not.toContain('apple-refresh')
        expect(await decryptOAuthToken(created.refreshToken as string)).toBe(
            'r.apple-refresh.0.abc',
        )
    })

    it('a re-sign-in replaces the stored refresh token, encrypted', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'apple-user@example.com',
            name: 'Existing',
            username: null,
            image: null,
            emailVerified: true,
        }
        prismaState.existingAccount = {
            id: 'existing-account-id',
            accessToken: 'old-at',
            refreshToken: 'old-encrypted-refresh',
            idToken: 'old-it',
        }

        await mintExtensionSession({
            provider: 'apple',
            providerUser,
            tokens: {
                accessToken: 'at',
                refreshToken: 'r.new.0.abc',
                idToken: 'it',
            },
        })

        const data = prismaMock.account.update.mock.calls[0][0].data
        expect(await decryptOAuthToken(data.refreshToken as string)).toBe(
            'r.new.0.abc',
        )
    })

    it('a re-sign-in that returns no refresh token keeps the one already stored', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'apple-user@example.com',
            name: 'Existing',
            username: null,
            image: null,
            emailVerified: true,
        }
        prismaState.existingAccount = {
            id: 'existing-account-id',
            accessToken: 'old-at',
            refreshToken: 'old-encrypted-refresh',
            idToken: 'old-it',
        }

        await mintExtensionSession({
            provider: 'apple',
            providerUser,
            tokens: { accessToken: 'at', idToken: 'it' },
        })

        expect(
            prismaMock.account.update.mock.calls[0][0].data.refreshToken,
        ).toBe('old-encrypted-refresh')
    })
})

describe('mintExtensionSession — no email, no existing account', () => {
    it.each(['google', 'apple'] as const)(
        '%s throws ExtensionOAuthEmailRequiredError tagged with the provider, creates nothing',
        async provider => {
            await expect(
                mintExtensionSession({
                    provider,
                    providerUser: { id: 'no-email-user', email: null },
                    tokens: {},
                }),
            ).rejects.toThrow(ExtensionOAuthEmailRequiredError)

            expect(prismaMock.user.create).not.toHaveBeenCalled()
            expect(prismaMock.account.create).not.toHaveBeenCalled()
            expect(prismaMock.session.create).not.toHaveBeenCalled()
        },
    )

    it('no email but an account ALREADY links this provider+id -> succeeds (found via the account branch)', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'user@example.com',
            name: null,
            username: null,
            image: null,
            emailVerified: true,
        }
        const result = await mintExtensionSession({
            provider: 'apple',
            providerUser: { id: 'apple-id-1', email: null },
            tokens: {},
        })
        expect(result.token).toBe(
            prismaMock.session.create.mock.calls[0][0].data.token,
        )
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })
})

// Replaces the old "bearer self-fetch fails -> falls back to the raw session
// token" pins: the self-fetch was structurally dead (404 path + unsigned
// cookie) and has been DELETED (NF-07), so the raw token isn't a fallback —
// it's the one and only return path, and the mint performs no fetch at all.
describe('mintExtensionSession — returns the raw session token directly (NF-07: dead bearer self-fetch deleted)', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('the returned token IS the Session row token, and the mint never fetches', async () => {
        vi.stubGlobal('fetch', () => {
            throw new Error(
                'mintExtensionSession must not fetch — the bearer self-fetch was deleted (NF-07)',
            )
        })
        const result = await mintExtensionSession({
            provider: 'google',
            providerUser: {
                id: 'g1',
                email: 'x@example.com',
                emailVerified: true,
            },
            tokens: {},
        })
        expect(typeof result.token).toBe('string')
        expect(result.token.length).toBeGreaterThan(0)
        expect(result.token).toBe(
            prismaMock.session.create.mock.calls[0][0].data.token,
        )
    })
})

describe('mintExtensionSession — returning user gets a FRESH profile in the response (NF-12)', () => {
    it('reassigns user to the update result so name/image reflect the provider, not the stale pre-update row', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'user@example.com',
            name: 'Old Name',
            username: null, // no username -> response username falls through to name
            image: 'https://example.com/old.png',
            emailVerified: true,
        }

        const result = await mintExtensionSession({
            provider: 'google',
            providerUser: {
                id: 'google-id-1',
                email: 'user@example.com',
                name: 'New Name',
                image: 'https://example.com/new.png',
                emailVerified: true,
            },
            tokens: { accessToken: 'at', idToken: 'it' },
        })

        expect(prismaMock.user.create).not.toHaveBeenCalled()
        expect(prismaMock.user.update).toHaveBeenCalledTimes(1)
        // Pre-NF-12 this returned the stale 'Old Name' / old.png (the update
        // result was discarded). Now the response carries the fresh values.
        expect(result.username).toBe('New Name')
        expect(result.image).toBe('https://example.com/new.png')
    })
})

// Security audit 2026-10-21 (T-5449). The lookup used one findFirst over
// (email OR provider account), and linking a provider to an UNVERIFIED account
// marked it verified while keeping whatever a stranger had set up on it.
describe('mintExtensionSession — which account a provider sign-in lands on', () => {
    type Where = { email?: string; accounts?: unknown }
    /** Answers the provider-link lookup and the email lookup separately. */
    function usersBy({
        linked,
        byEmail,
    }: {
        linked: Record<string, unknown> | null
        byEmail: Record<string, unknown> | null
    }) {
        prismaMock.user.findFirst.mockImplementation((async ({
            where,
        }: {
            where: Where
        }) => (where.accounts ? linked : byEmail)) as never)
    }

    const google = {
        provider: 'google' as const,
        providerUser: {
            id: 'google-id-1',
            email: 'owner@example.com',
            emailVerified: true,
        },
        tokens: { accessToken: 'at' },
    }

    it('M1: the user the provider account is linked to wins over a different user holding the email', async () => {
        const linked = {
            id: 'linked-user',
            email: 'old@example.com',
            emailVerified: true,
            username: null,
            name: 'Linked',
            image: null,
            accounts: [],
        }
        usersBy({
            linked,
            byEmail: {
                ...linked,
                id: 'email-user',
                email: 'owner@example.com',
            },
        })
        prismaState.existingUser = linked

        await mintExtensionSession(google)

        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'linked-user' } }),
        )
        expect(prismaMock.session.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ userId: 'linked-user' }),
        })
    })

    it('H3: claiming an UNVERIFIED account by email clears its password and drops its sessions first, keeping the row', async () => {
        const squatted = {
            id: 'squatted-user',
            email: 'owner@example.com',
            emailVerified: false,
            username: null,
            name: null,
            image: null,
            accounts: [],
        }
        usersBy({ linked: null, byEmail: squatted })
        prismaState.existingUser = squatted

        await mintExtensionSession(google)

        expect(prismaMock.account.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'squatted-user',
                providerId: 'credential',
                password: { not: null },
            },
            data: { password: null },
        })
        expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
            where: { userId: 'squatted-user' },
        })
        // ...before the owner's own session is minted, which must survive.
        const purgeOrder =
            prismaMock.session.deleteMany.mock.invocationCallOrder[0]
        const mintOrder = prismaMock.session.create.mock.invocationCallOrder[0]
        expect(purgeOrder).toBeLessThan(mintOrder)
        expect(prismaMock.account.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                providerId: 'google',
                userId: 'squatted-user',
            }),
        })
    })

    it('a VERIFIED account claimed by email keeps its password and sessions', async () => {
        const owner = {
            id: 'owner-user',
            email: 'owner@example.com',
            emailVerified: true,
            username: null,
            name: null,
            image: null,
            accounts: [],
        }
        usersBy({ linked: null, byEmail: owner })
        prismaState.existingUser = owner

        await mintExtensionSession(google)

        expect(prismaMock.account.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.session.deleteMany).not.toHaveBeenCalled()
    })

    it('a returning sign-in through an already-linked provider purges nothing, verified or not', async () => {
        const linked = {
            id: 'linked-user',
            email: 'owner@example.com',
            emailVerified: false,
            username: null,
            name: null,
            image: null,
            accounts: [],
        }
        usersBy({ linked, byEmail: linked })
        prismaState.existingUser = linked

        await mintExtensionSession(google)

        expect(prismaMock.account.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.session.deleteMany).not.toHaveBeenCalled()
    })
})
