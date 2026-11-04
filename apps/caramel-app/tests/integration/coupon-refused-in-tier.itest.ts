import { attachSignals } from '@/lib/couponSignals'
import { listStoreCoupons } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// T-13810: a code a store refused orders after the unrefused codes of its OWN
// proof tier, run for REAL against a live migrated Postgres. funko.com
// (2026-11-03): codes with fail_weight 1-2 still led the list at rating 4.2,
// because only the quorum-4 sink moved anything and the anonymous pool stops
// at weight 1.
//
// The suite creates its own catalog rows under a private site and id range
// (988100xxx) and removes them (and their signals) afterwards.

const SITE = 'refused-in-tier-13810.example'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

type Fixture = {
    id: string
    status: 'valid' | 'product_restriction' | 'pending'
    rating: number
    /** fail_weight and how long ago the latest failure was. */
    refused?: { failWeight: number; ago: number }
}

const FIXTURES: Fixture[] = [
    // Proven: the refused one has the best rating and still goes after the
    // unrefused one, but stays ahead of every other tier.
    {
        id: '988100001',
        status: 'valid',
        rating: 5,
        refused: { failWeight: 1, ago: HOUR },
    },
    { id: '988100002', status: 'valid', rating: 1 },
    // Restricted.
    {
        id: '988100003',
        status: 'product_restriction',
        rating: 4,
        refused: { failWeight: 2, ago: HOUR },
    },
    { id: '988100004', status: 'product_restriction', rating: 2 },
    // Unverified: a refusal outside the 30-day window no longer counts.
    {
        id: '988100005',
        status: 'pending',
        rating: 5,
        refused: { failWeight: 1, ago: 40 * DAY },
    },
    {
        id: '988100006',
        status: 'pending',
        rating: 4,
        refused: { failWeight: 1, ago: HOUR },
    },
    { id: '988100007', status: 'pending', rating: 3 },
]
const IDS = FIXTURES.map(f => f.id)

async function cleanup() {
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: IDS } },
    })
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
                code: `REFUSED${f.id}`,
                site: SITE,
                title: `Refused-in-tier fixture ${f.id}`,
                description: 'fixture',
                rating: f.rating,
                status: f.status,
                // One shared proof stamp, so rating decides inside a group.
                updatedAt: new Date(now - DAY),
            },
        })
        if (f.refused) {
            await prisma.couponSignal.create({
                data: {
                    couponId: f.id,
                    failCount: f.refused.failWeight,
                    failWeight: f.refused.failWeight,
                    lastFailedAt: new Date(now - f.refused.ago),
                    lastWorkedAt: null,
                },
            })
        }
    }
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('a code a store refused goes after its tier peers (real pg)', () => {
    it('reorders inside each proof tier only, and hides nothing', async () => {
        const { coupons, total } = await listStoreCoupons(SITE, 20)

        expect(coupons.map(c => c.id)).toEqual([
            '988100002', // proven
            '988100001', // proven, refused: after its peer, ahead of every other tier
            '988100004', // restricted
            '988100003', // restricted, refused
            '988100005', // unverified, its refusal is outside the window
            '988100007', // unverified
            '988100006', // unverified, refused
        ])
        expect(total).toBe(7)
    })

    it('the flags /api/coupons ships agree with the SQL order', async () => {
        const { coupons } = await listStoreCoupons(SITE, 20)
        const decorated = await attachSignals(coupons)

        expect(decorated.filter(c => c.recentlyRefused).map(c => c.id)).toEqual(
            ['988100001', '988100003', '988100006'],
        )
        // Below the sink quorum: refused, never sunk.
        expect(decorated.some(c => c.recentlyFailing)).toBe(false)
    })
})
