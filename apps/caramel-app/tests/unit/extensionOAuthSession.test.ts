import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
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
// there is no fetch (and no env read) anywhere in the mint.

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
        },
        session: {
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
        prismaMock.session.create,
    ]) {
        fn.mockClear()
    }
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
            expect(prismaMock.account.create.mock.calls[0][0].data).toEqual({
                providerId: provider,
                accountId: providerUser.id,
                userId: 'new-user-id',
                accessToken: 'at',
                idToken: 'it',
            })
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
            })
        },
    )

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
            expect(prismaMock.account.update).toHaveBeenCalledWith({
                where: { id: 'existing-account-id' },
                data: { accessToken: 'new-at', idToken: 'new-it' },
            })
        },
    )
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
