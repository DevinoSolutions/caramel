// Static import — vitest hoists the vi.mock calls below above it. A top-level
// `await import` would trip TS1378 under this tsconfig.
import { POST } from '@/app/api/account/data/delete/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/account/data/delete — the danger zone.
//
// Three properties this file exists to keep true:
//   1. The literal confirmation string is required SERVER-side. The typed
//      dialog is a second lock, not the only one.
//   2. It deletes only the caller's rows, and only the three login-features
//      tables — never the account, never the sync preference. Site suggestions
//      are the one exception and are SCRUBBED rather than deleted (the store
//      request is not personal data once the requester is off it).
//   3. It is TRANSACTIONAL: a partial failure leaves nothing deleted, which is
//      what makes the failure toast ("Nothing was removed") a true statement.
//
// This file pins the SHAPE of the batch. What the scrub's predicate actually
// SELECTS — the signed-out, email-only row a user_id match walks past — is
// pinned against an executing in-memory table in
// account-data-delete-suggestion-scrub.test.ts.

const { prismaMock, transactionMock } = vi.hoisted(() => {
    const transactionMock = vi.fn()
    return {
        transactionMock,
        prismaMock: {
            $transaction: transactionMock,
            savingsEvent: { deleteMany: vi.fn(() => ({ op: 'savings' })) },
            favoriteStore: { deleteMany: vi.fn(() => ({ op: 'favorites' })) },
            couponReport: { deleteMany: vi.fn(() => ({ op: 'reports' })) },
            siteSuggestion: {
                // Typed args, so the `data` key assertion below reads the real
                // call rather than an untyped `any` the compiler cannot check.
                updateMany: vi.fn(
                    (_args: {
                        where: unknown
                        data: Record<string, unknown>
                    }) => ({ op: 'suggestions' }),
                ),
                // Never called by this route: the store request must survive
                // the requester. Mocked so the "not called" assertion below is
                // a statement about the route, not about the fixture.
                deleteMany: vi.fn(),
            },
            // `delete` is mocked even though the route must never call it: a
            // "not called" assertion against a method the fixture does not
            // define is a statement about the fixture, not about the route.
            user: { update: vi.fn(), delete: vi.fn() },
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

const USER_ID = 'user-under-test'
const USER_EMAIL = 'shopper@example.com'

function deleteRequest(body: unknown) {
    return new NextRequest('http://localhost/api/account/data/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockResolvedValue({
        user: { id: USER_ID, email: USER_EMAIL },
    })
    transactionMock.mockResolvedValue([
        { count: 14 },
        { count: 6 },
        { count: 7 },
        { count: 3 },
    ])
})

describe('POST /api/account/data/delete — the confirmation gate', () => {
    it('deletes and reports real counts when the confirmation string is present', async () => {
        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: { savingsEvents: 14, favoriteStores: 6, couponReports: 7 },
            scrubbed: { siteSuggestions: 3 },
        })
        expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('a request with NO body is a 422 and destroys nothing', async () => {
        // The endpoint must never be reachable as a bare
        // unauthenticated-intent request.
        const res = await POST(
            new NextRequest('http://localhost/api/account/data/delete', {
                method: 'POST',
            }),
        )

        expect(res.status).toBe(422)
        expect(transactionMock).not.toHaveBeenCalled()
        expect(prismaMock.savingsEvent.deleteMany).not.toHaveBeenCalled()
    })

    it('the WRONG confirmation string is a 422 and destroys nothing', async () => {
        for (const confirm of ['delete', 'Delete', 'DELETE ', 'yes', '']) {
            vi.clearAllMocks()
            const res = await POST(deleteRequest({ confirm }))
            expect(res.status, `confirm=${JSON.stringify(confirm)}`).toBe(422)
            expect(transactionMock).not.toHaveBeenCalled()
        }
    })

    it('a missing confirm field is a 422', async () => {
        const res = await POST(deleteRequest({ somethingElse: true }))
        expect(res.status).toBe(422)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an anonymous caller gets 401 even WITH the confirmation string', async () => {
        getSessionMock.mockResolvedValue(null)
        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(res.status).toBe(401)
        expect(transactionMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/account/data/delete — scope', () => {
    it('scopes all three deletes to the caller and to nothing else', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(prismaMock.savingsEvent.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER_ID },
        })
        expect(prismaMock.favoriteStore.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER_ID },
        })
        expect(prismaMock.couponReport.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER_ID },
        })
        // The suggestion scrub is matched TWO ways — the second is the whole
        // point, because a signed-out request carries no user id at all.
        expect(prismaMock.siteSuggestion.updateMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { userId: USER_ID },
                    {
                        requesterEmail: {
                            equals: USER_EMAIL,
                            mode: 'insensitive',
                        },
                    },
                ],
            },
            data: { userId: null, requesterEmail: null, userAgent: null },
        })
    })

    it('a site suggestion is SCRUBBED, never deleted — the store request survives its requester', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        expect(prismaMock.siteSuggestion.updateMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.siteSuggestion.deleteMany).not.toHaveBeenCalled()
        // Only the identifying half is nulled. domain/status/created_at are
        // absent from `data`, so the pipeline's input is untouched, and nothing
        // new is stamped: a scrub is not an ANSWER to the request.
        const [args] = prismaMock.siteSuggestion.updateMany.mock.calls[0]!
        expect(Object.keys(args.data).sort()).toEqual([
            'requesterEmail',
            'userAgent',
            'userId',
        ])
    })

    it('does NOT delete the account and does NOT touch the sync preference', async () => {
        const res = await POST(deleteRequest({ confirm: 'DELETE' }))

        // The POSITIVE half first. Without it both negatives below are
        // trivially true whenever the request never got as far as deleting
        // anything — a 401, a 422 from a changed body schema, an early return —
        // so the test would go green on a route that does nothing at all,
        // which is the opposite of what it claims to verify.
        expect(res.status).toBe(200)
        expect(transactionMock).toHaveBeenCalledTimes(1)
        expect(prismaMock.savingsEvent.deleteMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.favoriteStore.deleteMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.couponReport.deleteMany).toHaveBeenCalledTimes(1)

        // Only now is "and nothing else happened" a real statement. Toggling
        // sync off and deleting history are deliberately separate acts — a
        // delete that also changed a setting the user never touched would make
        // the danger zone do something it did not say it would.
        expect(prismaMock.user.update).not.toHaveBeenCalled()
        expect(prismaMock.user.delete).not.toHaveBeenCalled()
    })
})

describe('POST /api/account/data/delete — transactional', () => {
    it('runs all three deletes AND the suggestion scrub inside ONE $transaction, never as loose awaits', async () => {
        await POST(deleteRequest({ confirm: 'DELETE' }))

        const batch = transactionMock.mock.calls[0]![0]
        expect(Array.isArray(batch)).toBe(true)
        expect(batch).toHaveLength(4)
        // The builders were invoked to BUILD the batch, and their results were
        // handed to $transaction rather than awaited separately. The scrub is
        // IN here on purpose: run as a fourth loose await after a successful
        // transaction, a failure would empty the three tables and leave the
        // email sitting in site_suggestions.
        expect(batch).toEqual([
            { op: 'savings' },
            { op: 'favorites' },
            { op: 'reports' },
            { op: 'suggestions' },
        ])
    })

    it('a partial failure deletes NOTHING and surfaces as a 500', async () => {
        // Prisma rolls the interactive batch back; withRoute's catch turns the
        // throw into a 500 + Sentry. The user is never told their data is gone
        // while some of it remains.
        transactionMock.mockRejectedValue(
            new Error('deadlock detected on favorite_stores'),
        )

        const res = await POST(deleteRequest({ confirm: 'DELETE' }))
        expect(res.status).toBe(500)
        // No second, non-transactional cleanup path exists to "finish the job".
        expect(transactionMock).toHaveBeenCalledTimes(1)
    })
})
