import { GET } from '@/app/api/coupons/recently-worked/route'
import { RecentlyWorkedCouponsResponseSchema } from '@/lib/recentlyWorkedCoupons'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/coupons/recently-worked — the landing strip's API. The cache module
// is MOCKED (its own behavior is pinned in recentlyWorkedCouponsCache.test.ts);
// this pins the route's contract: the shared wire schema, the 5-minute edge
// cache header, and loud (handleRouteError) failure.

const { cacheMock } = vi.hoisted(() => ({
    cacheMock: { getRecentlyWorkedCoupons: vi.fn() },
}))
vi.mock('@/lib/recentlyWorkedCouponsCache', () => cacheMock)
vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
}))

const COUPON = {
    id: '900000017',
    code: 'LEARN40',
    title: '40% off Pro annual',
    storeDomain: 'codecademy.com',
    discountType: 'PERCENTAGE',
    discountAmount: 40,
    lastWorkedAt: '2026-09-30T11:50:00.000Z',
}

beforeEach(() => {
    cacheMock.getRecentlyWorkedCoupons.mockReset()
})

const request = () =>
    new NextRequest('http://localhost/api/coupons/recently-worked')

describe('GET /api/coupons/recently-worked', () => {
    it('200 with the shared-contract body and a 5-minute edge cache', async () => {
        cacheMock.getRecentlyWorkedCoupons.mockResolvedValue([COUPON])

        const res = await GET(request())

        expect(res.status).toBe(200)
        expect(res.headers.get('Cache-Control')).toBe(
            'public, s-maxage=300, stale-while-revalidate=300',
        )
        const body = RecentlyWorkedCouponsResponseSchema.parse(await res.json())
        expect(body).toEqual({ coupons: [COUPON] })
    })

    it('an empty strip is a legitimate 200 { coupons: [] }', async () => {
        cacheMock.getRecentlyWorkedCoupons.mockResolvedValue([])

        const res = await GET(request())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ coupons: [] })
    })

    it('a read failure is a 500 through handleRouteError, not an empty list', async () => {
        cacheMock.getRecentlyWorkedCoupons.mockRejectedValue(
            new Error('db down'),
        )

        const res = await GET(request())

        expect(res.status).toBe(500)
    })
})
