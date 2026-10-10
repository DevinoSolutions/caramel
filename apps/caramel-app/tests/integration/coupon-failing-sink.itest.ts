import { attachSignals } from '@/lib/couponSignals'
import { isRecentlyFailing } from '@/lib/coupons'
import { listCoupons, listStoreCoupons } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// #288 — recently-failing codes SINK in a store's list (listStoreCoupons and the
// store-scoped listCoupons), run for REAL against a live migrated Postgres: the
// hashed `id IN (SELECT … FROM coupon_signals …)` ORDER BY key, the
// timestamp-WITHOUT-time-zone window compared against UTC, and agreement with
// coupons.ts's isRecentlyFailing (the card's hint).
//
// The suite creates its own catalog rows under a private site and id range
// (988000xxx) and removes them (and their signals) afterwards.

const SITE = 'failing-sink-288.example'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

type Fixture = {
    id: string
    rating: number
    signal?: {
        failCount: number
        lastFailedAt: number // ms ago
        lastWorkedAt?: number // ms ago
    }
}

// Listed in expected ranking order WITHOUT any sinking (rating DESC).
const FIXTURES: Fixture[] = [
    // Failing: 3 failures, the latest an hour ago, never worked.
    {
        id: '988000001',
        rating: 5,
        signal: { failCount: 3, lastFailedAt: HOUR },
    },
    { id: '988000002', rating: 4 },
    // Reset: failures, then a success AFTER the last one.
    {
        id: '988000003',
        rating: 3,
        signal: { failCount: 5, lastFailedAt: 2 * DAY, lastWorkedAt: DAY },
    },
    // Expired: failures, but the latest is outside the 30-day window.
    {
        id: '988000004',
        rating: 2,
        signal: { failCount: 4, lastFailedAt: 40 * DAY },
    },
    // Noise: a single recent failure.
    {
        id: '988000005',
        rating: 1,
        signal: { failCount: 1, lastFailedAt: HOUR },
    },
    // Failing: the success pre-dates the latest failure.
    {
        id: '988000006',
        rating: 0.5,
        signal: { failCount: 2, lastFailedAt: HOUR, lastWorkedAt: 5 * DAY },
    },
]
const IDS = FIXTURES.map(f => f.id)

async function cleanup() {
    await prisma.couponSignal.deleteMany({ where: { couponId: { in: IDS } } })
    await prisma.coupon.deleteMany({ where: { id: { in: IDS } } })
}

beforeAll(async () => {
    await cleanup()
    const now = Date.now()
    for (const f of FIXTURES) {
        await prisma.coupon.create({
            data: {
                id: f.id,
                code: `SINK${f.id}`,
                site: SITE,
                title: `Sink fixture ${f.id}`,
                description: 'fixture',
                rating: f.rating,
                status: 'valid',
            },
        })
        if (f.signal) {
            await prisma.couponSignal.create({
                data: {
                    couponId: f.id,
                    failCount: f.signal.failCount,
                    lastFailedAt: new Date(now - f.signal.lastFailedAt),
                    lastWorkedAt:
                        f.signal.lastWorkedAt === undefined
                            ? null
                            : new Date(now - f.signal.lastWorkedAt),
                },
            })
        }
    }
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('failing codes sink (real pg)', () => {
    it('listStoreCoupons: failing codes go last, the rest keep their ranking order, nothing is hidden', async () => {
        const { coupons, total } = await listStoreCoupons(SITE, 20)

        expect(coupons.map(c => c.id)).toEqual([
            '988000002', // rating 4
            '988000003', // rating 3, reset by a later success
            '988000004', // rating 2, failure outside the window
            '988000005', // rating 1, a single failure
            '988000001', // rating 5 but failing
            '988000006', // rating 0.5 and failing
        ])
        expect(total).toBe(6)
    })

    it('listCoupons with a site orders identically and pages consistently', async () => {
        const first = await listCoupons({ baseSite: SITE, limit: 4, skip: 0 })
        const second = await listCoupons({ baseSite: SITE, limit: 4, skip: 4 })

        expect(first.coupons.map(c => c.id)).toEqual([
            '988000002',
            '988000003',
            '988000004',
            '988000005',
        ])
        // The failing codes are on page 2 even though one has the best rating:
        // a post-fetch sort of page 1 could not have put them there.
        expect(second.coupons.map(c => c.id)).toEqual([
            '988000001',
            '988000006',
        ])
        expect(first.total).toBe(6)
        expect(second.total).toBe(6)
    })

    it('the SQL ordering and isRecentlyFailing agree on which codes are failing', async () => {
        const { coupons } = await listStoreCoupons(SITE, 20)
        const decorated = await attachSignals(coupons)

        const failingByTs = decorated
            .filter(c => isRecentlyFailing(c))
            .map(c => c.id)
        const tail = decorated.slice(-failingByTs.length).map(c => c.id)

        // Both lists keep list order, so no sorting is needed to compare them.
        expect(failingByTs).toEqual(['988000001', '988000006'])
        expect(tail).toEqual(failingByTs)
    })

    it('a later success lifts a failing code back to its ranking position', async () => {
        await prisma.couponSignal.update({
            where: { couponId: '988000001' },
            data: { lastWorkedAt: new Date() },
        })
        const { coupons } = await listStoreCoupons(SITE, 20)

        expect(coupons[0]?.id).toBe('988000001')
    })
})
