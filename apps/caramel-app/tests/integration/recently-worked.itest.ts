import { listRecentlyWorkedCoupons } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// listRecentlyWorkedCoupons (the landing page's "Codes that just worked"
// read) run for REAL against a live migrated + seeded Postgres: the
// coupon_signals ⋈ coupons join, the 24h UTC window compared against a
// timestamp-WITHOUT-time-zone column that prisma writes as UTC, the shared
// visibility predicate, and the zod row parse.
//
// The suite writes coupon_signals rows for a handful of SEEDED catalog ids
// (plus one id with no catalog row). Any signal row those ids already had is
// snapshotted first and restored afterwards, so a developer's local DB comes
// back exactly as it was. The catalog (`coupons`) is only ever READ.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

const FRESH_VISIBLE = '900000017' // LEARN40, codecademy.com — worked 10 min ago
const OLDER_VISIBLE = '900000001' // visible ebay.com code — worked 3h ago
const STALE_VISIBLE = '900000002' // visible — worked 25h ago (outside window)
const FRESH_INVALID = '900000008' // status invalid — worked 5 min ago (hidden)
const NO_CATALOG_ROW = '999000099' // no coupons row — worked 1 min ago

const SEEDED_SIGNALS: Array<[string, number]> = [
    [FRESH_VISIBLE, 10 * MINUTE],
    [OLDER_VISIBLE, 3 * HOUR],
    [STALE_VISIBLE, 25 * HOUR],
    [FRESH_INVALID, 5 * MINUTE],
    [NO_CATALOG_ROW, MINUTE],
]
const TOUCHED_IDS = SEEDED_SIGNALS.map(([id]) => id)

type SignalSnapshot = Awaited<ReturnType<typeof prisma.couponSignal.findMany>>
let snapshot: SignalSnapshot = []

beforeAll(async () => {
    snapshot = await prisma.couponSignal.findMany({
        where: { couponId: { in: TOUCHED_IDS } },
    })
    const now = Date.now()
    for (const [couponId, ageMs] of SEEDED_SIGNALS) {
        const lastWorkedAt = new Date(now - ageMs)
        await prisma.couponSignal.upsert({
            where: { couponId },
            create: { couponId, lastWorkedAt },
            update: { lastWorkedAt },
        })
    }
})

afterAll(async () => {
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: TOUCHED_IDS } },
    })
    if (snapshot.length > 0) {
        await prisma.couponSignal.createMany({ data: snapshot })
    }
    await prisma.$disconnect()
})

describe('listRecentlyWorkedCoupons (real pg)', () => {
    it('returns only VISIBLE catalog codes worked in the last 24h, newest first, with the parsed row shape', async () => {
        // A roomy limit so unrelated local signal rows can't push ours off the
        // page; assertions are then scoped to the ids this suite seeded.
        const rows = await listRecentlyWorkedCoupons(200)
        const ours = rows.filter(r => TOUCHED_IDS.includes(r.id))

        expect(ours.map(r => r.id)).toEqual([FRESH_VISIBLE, OLDER_VISIBLE])

        const learn40 = ours[0]!
        expect(learn40).toMatchObject({
            id: '900000017',
            code: 'LEARN40',
            site: 'codecademy.com',
            title: '40% off Pro annual',
            discount_type: 'PERCENTAGE',
            discount_amount: 40,
        })
        expect(learn40.lastWorkedAt).toBeInstanceOf(Date)
        // Written as UTC by prisma and read back as UTC: the round trip lands
        // within seconds of "10 minutes ago", not hours off by a TZ offset.
        const ageMs = Date.now() - learn40.lastWorkedAt.getTime()
        expect(ageMs).toBeGreaterThan(9 * MINUTE)
        expect(ageMs).toBeLessThan(11 * MINUTE)

        // Newest apply first across the WHOLE result, not just our ids.
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1]!.lastWorkedAt.getTime()).toBeGreaterThanOrEqual(
                rows[i]!.lastWorkedAt.getTime(),
            )
        }
    })

    it('honours the LIMIT', async () => {
        const rows = await listRecentlyWorkedCoupons(1)
        expect(rows).toHaveLength(1)
    })
})
