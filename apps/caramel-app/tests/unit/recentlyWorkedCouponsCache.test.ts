import {
    RECENTLY_WORKED_TTL_MS,
    getRecentlyWorkedCoupons,
    resetRecentlyWorkedCouponsCache,
} from '@/lib/recentlyWorkedCouponsCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins src/lib/recentlyWorkedCouponsCache.ts: ONE listRecentlyWorkedCoupons
// read (LIMIT 8) mapped to the wire contract, cached per process for 5
// minutes, in-flight de-duplicated, stale-on-error WITH a Sentry report. The
// repo boundary is MOCKED (no SQL runs — the SQL itself is pinned in
// couponsRepo.test.ts and run for real in coupons-read.itest.ts).

const { repoMock, sentryMock } = vi.hoisted(() => ({
    repoMock: { listRecentlyWorkedCoupons: vi.fn() },
    sentryMock: { captureException: vi.fn() },
}))
vi.mock('@/lib/couponsRepo', () => repoMock)
vi.mock('@sentry/nextjs', () => sentryMock)

const ROWS = [
    {
        id: '900000017',
        code: 'LEARN40',
        site: 'codecademy.com',
        title: '40% off Pro annual',
        discount_type: 'PERCENTAGE',
        discount_amount: 40,
        lastWorkedAt: new Date('2026-09-30T11:50:00.000Z'),
    },
    {
        // A subdomain slug links to its registrable domain's store page.
        id: '2',
        code: 'GAP10',
        site: 'athleta.gap.com',
        title: '10% off',
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
        lastWorkedAt: new Date('2026-09-30T10:00:00.000Z'),
    },
    {
        // A bare public suffix has no store page to link to — dropped.
        id: '3',
        code: 'SUFFIX',
        site: 'co.uk',
        title: 'Not a store',
        discount_type: null,
        discount_amount: null,
        lastWorkedAt: new Date('2026-09-30T09:00:00.000Z'),
    },
]

beforeEach(() => {
    resetRecentlyWorkedCouponsCache()
    repoMock.listRecentlyWorkedCoupons.mockReset()
    repoMock.listRecentlyWorkedCoupons.mockResolvedValue(ROWS)
    sentryMock.captureException.mockReset()
})

describe('getRecentlyWorkedCoupons', () => {
    it('reads 8 rows and maps them to the wire contract (registrable storeDomain, ISO lastWorkedAt), dropping suffix-only sites', async () => {
        const coupons = await getRecentlyWorkedCoupons()
        expect(repoMock.listRecentlyWorkedCoupons).toHaveBeenCalledWith(8)
        expect(coupons).toEqual([
            {
                id: '900000017',
                code: 'LEARN40',
                title: '40% off Pro annual',
                storeDomain: 'codecademy.com',
                discountType: 'PERCENTAGE',
                discountAmount: 40,
                lastWorkedAt: '2026-09-30T11:50:00.000Z',
            },
            {
                id: '2',
                code: 'GAP10',
                title: '10% off',
                storeDomain: 'gap.com',
                discountType: 'PERCENTAGE',
                discountAmount: 10,
                lastWorkedAt: '2026-09-30T10:00:00.000Z',
            },
        ])
    })

    it('serves from memory within the TTL and rebuilds once it has expired', async () => {
        const t0 = 1_000_000
        const first = await getRecentlyWorkedCoupons(t0)
        const warm = await getRecentlyWorkedCoupons(
            t0 + RECENTLY_WORKED_TTL_MS - 1,
        )
        expect(warm).toBe(first)
        expect(repoMock.listRecentlyWorkedCoupons).toHaveBeenCalledTimes(1)

        await getRecentlyWorkedCoupons(Date.now() + RECENTLY_WORKED_TTL_MS + 1)
        expect(repoMock.listRecentlyWorkedCoupons).toHaveBeenCalledTimes(2)
    })

    it('de-duplicates concurrent cold callers into ONE read', async () => {
        await Promise.all([
            getRecentlyWorkedCoupons(),
            getRecentlyWorkedCoupons(),
            getRecentlyWorkedCoupons(),
        ])
        expect(repoMock.listRecentlyWorkedCoupons).toHaveBeenCalledTimes(1)
    })

    it('a failed rebuild keeps serving the previous list AND reports the failure to Sentry', async () => {
        const first = await getRecentlyWorkedCoupons()
        const boom = new Error('db down')
        repoMock.listRecentlyWorkedCoupons.mockRejectedValue(boom)

        const stale = await getRecentlyWorkedCoupons(
            Date.now() + RECENTLY_WORKED_TTL_MS + 1,
        )
        expect(stale).toBe(first)
        expect(sentryMock.captureException).toHaveBeenCalledWith(
            boom,
            expect.objectContaining({
                tags: { area: 'recentlyWorkedCouponsCache.rebuild' },
            }),
        )
    })

    it('with nothing cached, a failed read throws (the route reports it) rather than inventing an empty list', async () => {
        repoMock.listRecentlyWorkedCoupons.mockRejectedValue(new Error('down'))
        await expect(getRecentlyWorkedCoupons()).rejects.toThrow('down')
    })
})
