// Static import — vitest hoists the vi.mock calls below above it.
import { POST } from '@/app/api/account/delete/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/account/delete — in-app account deletion (App Review 5.1.1(v)).
//
// What this file keeps true:
//   1. The literal confirmation is required SERVER-side (schema, 422).
//   2. It deletes the USER row of the caller and only that: the cascade in
//      prisma/schema.prisma removes the sessions, accounts and data, so the
//      route must not hand-delete tables a later schema change could add to.
//   3. The requester's identity is scrubbed off site suggestions IN THE SAME
//      transaction, and with the same predicate data/delete uses.
//   4. It is all-or-nothing: a failed transaction is a 500 that reaches Sentry
//      and deletes nothing.
//   5. It works for the native app's request shape: a bearer and NO Origin.
// Which rows the user delete cascades to is the database's job (the FK
// onDelete rules); that is pinned by the schema, not re-simulated here.

const { prismaMock, transactionMock } = vi.hoisted(() => {
    const transactionMock = vi.fn()
    return {
        transactionMock,
        prismaMock: {
            $transaction: transactionMock,
            siteSuggestion: {
                updateMany: vi.fn(
                    (_args: {
                        where: unknown
                        data: Record<string, unknown>
                    }) => ({ op: 'suggestions' }),
                ),
            },
            verification: {
                deleteMany: vi.fn((_args: { where: unknown }) => ({
                    op: 'verification',
                })),
            },
            user: {
                deleteMany: vi.fn((_args: { where: { id: string } }) => ({
                    op: 'user',
                })),
                // Never used by this route; mocked so "not called" is a
                // statement about the route and not about the fixture.
                delete: vi.fn(),
            },
            session: { deleteMany: vi.fn() },
            account: { deleteMany: vi.fn() },
            savingsEvent: { deleteMany: vi.fn() },
            favoriteStore: { deleteMany: vi.fn() },
            couponReport: { deleteMany: vi.fn() },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
}))

// TEST DOUBLE for the Apple revoke (its own behaviour, form fields and failure
// reporting are pinned in apple-token-revocation.test.ts). Here only the
// route's contract with it: tokens read BEFORE the transaction, revoke called
// AFTER the commit and only for the request that deleted, a failed revoke
// reported but never a failed request.
const { loadTargetsMock, revokeGrantsMock, callOrder } = vi.hoisted(() => {
    const callOrder: string[] = []
    return {
        callOrder,
        loadTargetsMock: vi.fn(async (_userId: string) => {
            callOrder.push('load')
            return [] as { refreshToken: string | null; accessToken: null }[]
        }),
        revokeGrantsMock: vi.fn(
            async (_targets: readonly unknown[]) =>
                'not_applicable' as 'not_applicable' | 'revoked' | 'failed',
        ),
    }
})
vi.mock('@/lib/auth/appleTokenRevocation', () => ({
    loadAppleRevocationTargets: loadTargetsMock,
    revokeAppleGrants: revokeGrantsMock,
}))

// TEST DOUBLE for the PostHog person delete (its own behaviour is pinned in
// posthog-person-deletion.test.ts). Here only the route's contract with it:
// called AFTER the commit, only by the request that deleted, never fails the
// request, and the outcome is in the response.
const { deletePersonMock } = vi.hoisted(() => ({
    deletePersonMock: vi.fn(
        async (_userId: string) =>
            'deleted' as 'deleted' | 'not_applicable' | 'failed',
    ),
}))
vi.mock('@/lib/analytics/posthogPersonDeletion', () => ({
    deletePosthogPerson: (userId: string) => {
        callOrder.push('posthog')
        return deletePersonMock(userId)
    },
}))

const USER_ID = 'user-under-test'
const USER_EMAIL = 'Shopper@Example.com'

function deleteRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    deletePersonMock.mockResolvedValue('deleted')
    loadTargetsMock.mockImplementation(async () => {
        callOrder.push('load')
        return []
    })
    revokeGrantsMock.mockImplementation(async () => {
        callOrder.push('revoke')
        return 'not_applicable'
    })
    getSessionMock.mockResolvedValue({
        user: { id: USER_ID, email: USER_EMAIL },
    })
    transactionMock.mockImplementation(async () => {
        callOrder.push('transaction')
        return [{ count: 2 }, { count: 1 }, { count: 1 }]
    })
})

describe('POST /api/account/delete', () => {
    it('deletes the caller and reports it', async () => {
        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: true,
            scrubbed: { siteSuggestions: 2 },
            appleRevocation: 'not_applicable',
            analyticsDeletion: 'deleted',
        })
        expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({
            where: { id: USER_ID },
        })
    })

    it('scrubs the requester identity in the same transaction, before the user goes', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(transactionMock).toHaveBeenCalledTimes(1)
        // The batch is [suggestions scrub, verification erase, user delete],
        // in that order: the scrub needs the email the user row carries.
        expect(transactionMock.mock.calls[0]![0]).toEqual([
            { op: 'suggestions' },
            { op: 'verification' },
            { op: 'user' },
        ])
        const scrub = prismaMock.siteSuggestion.updateMany.mock.calls[0]![0]
        expect(scrub.where).toEqual({
            OR: [
                { userId: USER_ID },
                { requesterEmail: 'shopper@example.com' },
            ],
        })
        expect(scrub.data).toMatchObject({
            userId: null,
            requesterEmail: null,
            userAgent: null,
        })
    })

    it('erases the one-time tokens that name the account (reset value = user id, identifier = address), anchored so another address is left alone', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        const erase = prismaMock.verification.deleteMany.mock.calls[0]![0]
        expect(erase.where).toEqual({
            OR: [
                { value: USER_ID },
                {
                    identifier: {
                        in: [
                            'shopper@example.com',
                            'sign-in-otp-shopper@example.com',
                            'email-verification-otp-shopper@example.com',
                            'forget-password-otp-shopper@example.com',
                        ],
                    },
                },
            ],
        })
    })

    it('leaves the cascades to the schema: no hand-written deletes of dependants', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(prismaMock.session.deleteMany).not.toHaveBeenCalled()
        expect(prismaMock.account.deleteMany).not.toHaveBeenCalled()
        expect(prismaMock.savingsEvent.deleteMany).not.toHaveBeenCalled()
        expect(prismaMock.favoriteStore.deleteMany).not.toHaveBeenCalled()
        expect(prismaMock.couponReport.deleteMany).not.toHaveBeenCalled()
        expect(prismaMock.user.delete).not.toHaveBeenCalled()
    })

    it('a lost race (the user row already gone) is a no-op answered 200 with deleted false', async () => {
        transactionMock.mockResolvedValue([
            { count: 0 },
            { count: 0 },
            { count: 0 },
        ])

        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: false,
            scrubbed: { siteSuggestions: 0 },
            appleRevocation: 'not_applicable',
            analyticsDeletion: 'not_applicable',
        })
        // The winner of the race owns the revoke.
        expect(revokeGrantsMock).not.toHaveBeenCalled()
    })

    describe('PostHog person deletion (T-7505)', () => {
        it('runs AFTER the transaction commits, for the session user id', async () => {
            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(res.status).toBe(200)
            expect(deletePersonMock).toHaveBeenCalledWith(USER_ID)
            expect(callOrder).toEqual([
                'load',
                'transaction',
                'revoke',
                'posthog',
            ])
        })

        it('is not called by the loser of a delete race, nor when the transaction fails', async () => {
            transactionMock.mockResolvedValueOnce([
                { count: 0 },
                { count: 0 },
                { count: 0 },
            ])
            const lost = await POST(deleteRequest({ confirm: 'DELETE' }))
            expect(await lost.json()).toMatchObject({
                analyticsDeletion: 'not_applicable',
            })

            transactionMock.mockRejectedValueOnce(new Error('db down'))
            const failed = await POST(deleteRequest({ confirm: 'DELETE' }))
            expect(failed.status).toBe(500)
            expect(deletePersonMock).not.toHaveBeenCalled()
        })

        it('a failed PostHog delete never fails the request; the response says so', async () => {
            deletePersonMock.mockResolvedValue('failed')

            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject({
                deleted: true,
                analyticsDeletion: 'failed',
            })
        })
    })

    describe('Sign in with Apple revocation (T-5065)', () => {
        const appleTargets = [
            { refreshToken: 'stored-token', accessToken: null },
        ]

        it('reads the Apple tokens BEFORE the transaction and revokes them AFTER it commits', async () => {
            loadTargetsMock.mockImplementation(async () => {
                callOrder.push('load')
                return appleTargets
            })
            revokeGrantsMock.mockImplementation(async () => {
                callOrder.push('revoke')
                return 'revoked'
            })

            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject({
                deleted: true,
                appleRevocation: 'revoked',
            })
            expect(callOrder).toEqual([
                'load',
                'transaction',
                'revoke',
                'posthog',
            ])
            expect(loadTargetsMock).toHaveBeenCalledWith(USER_ID)
            expect(revokeGrantsMock).toHaveBeenCalledWith(appleTargets)
        })

        it('a user with no Apple account still goes through the same calls and gets not_applicable', async () => {
            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(await res.json()).toMatchObject({
                appleRevocation: 'not_applicable',
            })
            expect(revokeGrantsMock).toHaveBeenCalledWith([])
        })

        it('a failed revoke is surfaced in the response, and the completed deletion stays a 200', async () => {
            loadTargetsMock.mockResolvedValue(appleTargets)
            revokeGrantsMock.mockResolvedValue('failed')

            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({
                deleted: true,
                scrubbed: { siteSuggestions: 2 },
                appleRevocation: 'failed',
                analyticsDeletion: 'deleted',
            })
        })

        it('a failed transaction revokes nothing (the account still exists)', async () => {
            loadTargetsMock.mockResolvedValue(appleTargets)
            transactionMock.mockRejectedValue(new Error('connection reset'))

            const res = await POST(deleteRequest({ confirm: 'DELETE' }))

            expect(res.status).toBe(500)
            expect(revokeGrantsMock).not.toHaveBeenCalled()
        })

        it('an unauthenticated or unconfirmed request neither reads nor revokes tokens', async () => {
            getSessionMock.mockResolvedValue(null)
            await POST(deleteRequest({ confirm: 'DELETE' }))
            getSessionMock.mockResolvedValue({
                user: { id: USER_ID, email: USER_EMAIL },
            })
            await POST(deleteRequest({ confirm: 'nope' }))

            expect(loadTargetsMock).not.toHaveBeenCalled()
            expect(revokeGrantsMock).not.toHaveBeenCalled()
        })
    })

    it('works for the native app: a bearer and no Origin header', async () => {
        const res = await POST(
            deleteRequest(
                { confirm: 'DELETE' },
                { authorization: 'Bearer app-session-token' },
            ),
        )

        expect(res.status).toBe(200)
        const headers = getSessionMock.mock.calls[0]![0].headers
        expect(headers.get('authorization')).toBe('Bearer app-session-token')
        expect(headers.get('origin')).toBeNull()
    })

    it('refuses a cross-origin browser caller (the CSRF gate for a cookie session)', async () => {
        const res = await POST(
            deleteRequest(
                { confirm: 'DELETE' },
                { origin: 'https://evil.example.com' },
            ),
        )

        expect(res.status).toBe(403)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an anonymous caller gets 401 even WITH the confirmation', async () => {
        getSessionMock.mockResolvedValue(null)

        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(401)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('a missing, empty or wrong confirmation is a 422 and deletes nothing', async () => {
        for (const confirm of [undefined, '', 'delete', 'DELETE ', 'yes']) {
            vi.clearAllMocks()
            const res = await POST(deleteRequest({ confirm }))
            expect(res.status, `confirm=${JSON.stringify(confirm)}`).toBe(422)
            expect(transactionMock).not.toHaveBeenCalled()
        }
        const bare = await POST(
            new NextRequest('http://localhost/api/account/delete', {
                method: 'POST',
            }),
        )
        expect(bare.status).toBe(422)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('a failed transaction is a 500 that reaches Sentry, never a quiet success', async () => {
        const boom = new Error('connection reset')
        transactionMock.mockRejectedValue(boom)

        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(500)
        expect(captureExceptionMock).toHaveBeenCalled()
        expect(captureExceptionMock.mock.calls[0]![0]).toBe(boom)
    })
})
