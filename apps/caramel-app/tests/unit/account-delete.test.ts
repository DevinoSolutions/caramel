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
    getSessionMock.mockResolvedValue({
        user: { id: USER_ID, email: USER_EMAIL },
    })
    transactionMock.mockResolvedValue([
        { count: 2 },
        { count: 1 },
        { count: 1 },
    ])
})

describe('POST /api/account/delete', () => {
    it('deletes the caller and reports it', async () => {
        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: true,
            scrubbed: { siteSuggestions: 2 },
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
