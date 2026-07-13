import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-007 — extensionOAuthSession unit tests (PLAN-F-007.md §Test
// strategy): google+apple both drive the SAME mintExtensionSession() and
// produce the output the pre-refactor route's two hand-rolled branches
// each produced independently. route-pipeline.test.ts exercises this
// through the real POST /api/extension/oauth handler (HTTP-level,
// end-to-end); this file exercises the module directly (unit-level),
// covering shapes route-pipeline.test.ts doesn't (e.g. account-token
// refresh on re-auth).

const { envMock } = vi.hoisted(() => ({
    envMock: {
        BETTER_AUTH_URL: 'http://localhost:58000' as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

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
                }) => ({ id: where.id, ...data }),
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

const fetchMock = vi.fn(
    async () =>
        new Response(null, {
            status: 200,
            headers: { 'set-auth-token': 'bearer-token-xyz' },
        }),
)

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    fetchMock.mockImplementation(
        async () =>
            new Response(null, {
                status: 200,
                headers: { 'set-auth-token': 'bearer-token-xyz' },
            }),
    )
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

            expect(result.token).toBe('bearer-token-xyz')
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
        expect(result.token).toBe('bearer-token-xyz')
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })
})

describe('mintExtensionSession — bearer self-fetch fails', () => {
    it('falls back to the raw session token rather than null/undefined', async () => {
        fetchMock.mockImplementation(
            async () => new Response(null, { status: 401 }),
        )
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
        expect(result.token).not.toBe('bearer-token-xyz')
    })

    it('a thrown fetch (network error) also falls back to the raw session token, not an unhandled rejection', async () => {
        fetchMock.mockImplementation(async () => {
            throw new Error('network down')
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
    })
})
