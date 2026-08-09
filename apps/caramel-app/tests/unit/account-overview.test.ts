// Static import of the route under test — vitest hoists every vi.mock below
// above this, so the route sees the mocks (same shape coupons-report.test.ts
// uses). A top-level `await import` would trip TS1378 under this tsconfig.
import { GET } from '@/app/api/account/overview/route'
import type { ProfileOverview } from '@/lib/profile/types'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/account/overview — the ONE payload the account page reads.
//
// The DEFAULT user has zero of everything, so the zero-data contract is
// asserted FIRST and in full: a page built against a populated fixture ships a
// zero state that reads as a broken page.
//
// Mocking follows coupons-report.test.ts: mock @/lib/prisma, keep
// isOriginAllowed real (a no-Origin request passes), stub only the rate-limit
// round trip, and drive the exported GET with a constructed NextRequest.

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        user: { findUnique: vi.fn() },
        savingsEvent: {
            groupBy: vi.fn(),
            aggregate: vi.fn(),
            findMany: vi.fn(),
        },
        favoriteStore: { findMany: vi.fn() },
        couponReport: { findMany: vi.fn() },
    },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { countCouponsForStoresMock } = vi.hoisted(() => ({
    countCouponsForStoresMock: vi.fn(async () => new Map<string, number>()),
}))
vi.mock('@/lib/couponsRepo', () => ({
    countCouponsForStores: countCouponsForStoresMock,
}))

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
const OTHER_USER_ID = 'someone-else'
const MEMBER_SINCE = new Date('2026-03-14T10:00:00.000Z')

function overviewRequest() {
    return new NextRequest('http://localhost/api/account/overview', {
        method: 'GET',
    })
}

/** The empty-everything DB: what a brand-new account really looks like. */
function stubEmptyDatabase() {
    // One mock serves both reads of the users row: the route's own
    // createdAt lookup and readSavingsSyncEnabled's flag lookup.
    prismaMock.user.findUnique.mockResolvedValue({
        createdAt: MEMBER_SINCE,
        savingsSyncEnabled: false,
    })
    prismaMock.savingsEvent.groupBy.mockResolvedValue([])
    prismaMock.savingsEvent.aggregate.mockResolvedValue({
        _min: { occurredAt: null },
    })
    prismaMock.savingsEvent.findMany.mockResolvedValue([])
    prismaMock.favoriteStore.findMany.mockResolvedValue([])
    prismaMock.couponReport.findMany.mockResolvedValue([])
    countCouponsForStoresMock.mockResolvedValue(new Map())
}

beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockResolvedValue({ user: { id: USER_ID } })
    stubEmptyDatabase()
})

describe('GET /api/account/overview — the zero-data user (the DEFAULT)', () => {
    it('returns the exact empty contract: no nulls-as-zeroes, no invented numbers', async () => {
        const res = await GET(overviewRequest())
        expect(res.status).toBe(200)

        const body = (await res.json()) as ProfileOverview
        expect(body).toEqual({
            memberSince: MEMBER_SINCE.toISOString(),
            hasExtensionActivity: false,
            savings: {
                syncEnabled: false,
                eventCount: 0,
                storeCount: 0,
                totals: [],
                firstEventAt: null,
                recentEvents: [],
            },
            favorites: [],
            reports: {
                reportCount: 0,
                // null, NOT 0 — with nothing to confirm there is no
                // confirmation rate to state.
                confirmedCount: null,
                shoppersHelped: null,
            },
        })
    })

    it('totals is an EMPTY ARRAY, never a zero-valued entry — the page must never render a $0.00 hero', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.savings.totals).toEqual([])
    })

    it('skips the catalog count query entirely when there are no favorites', async () => {
        await GET(overviewRequest())
        expect(countCouponsForStoresMock).toHaveBeenCalledWith([])
    })
})

describe('GET /api/account/overview — authentication and scoping', () => {
    it('an anonymous caller gets 401 and no query runs', async () => {
        getSessionMock.mockResolvedValue(null)
        const res = await GET(overviewRequest())

        expect(res.status).toBe(401)
        expect(prismaMock.savingsEvent.groupBy).not.toHaveBeenCalled()
        expect(prismaMock.favoriteStore.findMany).not.toHaveBeenCalled()
        expect(prismaMock.couponReport.findMany).not.toHaveBeenCalled()
    })

    it('EVERY row query is scoped to the calling user', async () => {
        await GET(overviewRequest())

        // If any of these loses its userId filter, the endpoint starts
        // serving other people's savings — assert all of them, every time.
        expect(prismaMock.savingsEvent.groupBy).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER_ID } }),
        )
        expect(prismaMock.savingsEvent.aggregate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER_ID } }),
        )
        expect(prismaMock.savingsEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER_ID } }),
        )
        expect(prismaMock.favoriteStore.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER_ID } }),
        )
        expect(prismaMock.couponReport.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER_ID } }),
        )
        expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: USER_ID } }),
        )
        expect(
            JSON.stringify(prismaMock.savingsEvent.groupBy.mock.calls),
        ).not.toContain(OTHER_USER_ID)
    })

    it('caps the recent-events list server-side', async () => {
        await GET(overviewRequest())
        expect(prismaMock.savingsEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 25 }),
        )
    })
})

describe('GET /api/account/overview — populated aggregates', () => {
    beforeEach(() => {
        // Three currencies across four stores. EUR is deliberately the biggest
        // group so the sort is proven to be by amount, not by insertion or
        // alphabet.
        prismaMock.savingsEvent.groupBy.mockResolvedValue([
            {
                currency: 'USD',
                store: 'nike.com',
                _sum: { amountCents: 1200 },
                _count: { _all: 2 },
            },
            {
                currency: 'USD',
                store: 'gap.com',
                _sum: { amountCents: 800 },
                _count: { _all: 1 },
            },
            {
                currency: 'EUR',
                store: 'zalando.de',
                _sum: { amountCents: 5000 },
                _count: { _all: 3 },
            },
            {
                currency: 'GBP',
                store: 'asos.com',
                _sum: { amountCents: 450 },
                _count: { _all: 1 },
            },
        ])
        prismaMock.savingsEvent.aggregate.mockResolvedValue({
            _min: { occurredAt: new Date('2026-04-02T09:00:00.000Z') },
        })
        prismaMock.savingsEvent.findMany.mockResolvedValue([
            {
                store: 'nike.com',
                code: 'SAVE10',
                amountCents: 700,
                currency: 'USD',
                occurredAt: new Date('2026-06-01T12:00:00.000Z'),
            },
            {
                store: 'gap.com',
                code: '',
                amountCents: 800,
                currency: 'USD',
                occurredAt: new Date('2026-05-20T12:00:00.000Z'),
            },
        ])
        prismaMock.favoriteStore.findMany.mockResolvedValue([
            {
                storeName: 'nike.com',
                createdAt: new Date('2026-05-01T00:00:00.000Z'),
            },
            {
                storeName: 'obscure.example',
                createdAt: new Date('2026-04-01T00:00:00.000Z'),
            },
        ])
        countCouponsForStoresMock.mockResolvedValue(new Map([['nike.com', 12]]))
    })

    it('groups totals BY CURRENCY and never sums across them', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview

        // Sorted desc by amount: EUR 5000, USD 2000 (1200+800), GBP 450.
        expect(body.savings.totals).toEqual([
            { currency: 'EUR', minorUnits: 5000 },
            { currency: 'USD', minorUnits: 2000 },
            { currency: 'GBP', minorUnits: 450 },
        ])
        // The grand total 7450 must appear NOWHERE — adding euros to dollars
        // is a fabricated figure.
        const summed = body.savings.totals.reduce(
            (acc, total) => acc + total.minorUnits,
            0,
        )
        expect(summed).toBe(7450)
        expect(
            body.savings.totals.some(total => total.minorUnits === 7450),
        ).toBe(false)
    })

    it('counts events and DISTINCT stores across currency groups', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.savings.eventCount).toBe(7)
        expect(body.savings.storeCount).toBe(4)
        expect(body.savings.firstEventAt).toBe('2026-04-02T09:00:00.000Z')
    })

    it('maps an empty code to null so the row renders "automatic discount"', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.savings.recentEvents[0]?.code).toBe('SAVE10')
        expect(body.savings.recentEvents[1]?.code).toBeNull()
        expect(body.savings.recentEvents[1]?.storeDomain).toBe('gap.com')
    })

    it('a favorite with no catalog count gets null, NOT 0 — the UI omits the line rather than claiming zero codes', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.favorites).toEqual([
            {
                domain: 'nike.com',
                starredAt: '2026-05-01T00:00:00.000Z',
                couponCount: 12,
            },
            {
                domain: 'obscure.example',
                starredAt: '2026-04-01T00:00:00.000Z',
                couponCount: null,
            },
        ])
    })

    it('hasExtensionActivity is true once any savings event exists', async () => {
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.hasExtensionActivity).toBe(true)
    })

    it('hasExtensionActivity is true from REPORTS alone, with no savings at all', async () => {
        stubEmptyDatabase()
        prismaMock.couponReport.findMany.mockResolvedValue([
            {
                outcome: 'worked',
                createdAt: new Date('2026-05-01T00:00:00.000Z'),
                coupon: null,
            },
        ])

        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.hasExtensionActivity).toBe(true)
        expect(body.reports.reportCount).toBe(1)
    })

    it('syncEnabled reflects the users table', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            createdAt: MEMBER_SINCE,
            savingsSyncEnabled: true,
        })
        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.savings.syncEnabled).toBe(true)
    })

    it('reads the sync flag from the users table, NEVER off the session object', async () => {
        // better-auth projects only the fields it knows onto session.user, so
        // a custom column arrives there as undefined — falsy, and therefore
        // indistinguishable from a real "off". A session that CLAIMS the flag
        // must not be believed. Mirrors the protection the savings-sync PR
        // pinned on GET /api/extension/me.
        getSessionMock.mockResolvedValue({
            user: { id: USER_ID, savingsSyncEnabled: false },
            session: { id: 'sess' },
        })
        prismaMock.user.findUnique.mockResolvedValue({
            createdAt: MEMBER_SINCE,
            savingsSyncEnabled: true,
        })

        const body = (await (
            await GET(overviewRequest())
        ).json()) as ProfileOverview
        expect(body.savings.syncEnabled).toBe(true)
        expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({ savingsSyncEnabled: true }),
            }),
        )
    })
})
