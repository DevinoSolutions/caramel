import { recordUsage } from '@/lib/couponSignals'
import { expireCoupons, requestSource } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

// W4-D2 integration — the sanctioned WRITES exercised against the REAL prisma
// client + live local Postgres (:28005), catalog migrated (the harness/CI runs
// `prisma migrate deploy` first). This is the real proof the flipped writes hit
// the app's OWN tables (DATABASE_URL), not the external caramel_coupons DB.
//
// Every row this suite creates uses a PRIVATE id range (700070xxx) + a unique
// site/website that neither the seed nor any other integration file touches, so
// it can't collide with: the seed's 9000000xx coupons / seed-source-00x
// sources, ingest-catalog.itest.ts's 8000xxxxx ebay inserts,
// coupon-signal.itest.ts's 999000xxx signals, or coupons-read.itest.ts's
// assertions (its coupons filter to 9000000*, its getCouponStats census is
// status='valid' — ours are 'pending' — and its listActiveSources is
// ACTIVE-only — ours is REQUESTED). Everything is deleted after each test so
// the suite is idempotent and re-runnable.
const USAGE_ID = '700070001'
const EXPIRE_LIVE_A = '700070002'
const EXPIRE_LIVE_B = '700070003'
const EXPIRE_ALREADY = '700070004'
const ALL_COUPON_IDS = [USAGE_ID, EXPIRE_LIVE_A, EXPIRE_LIVE_B, EXPIRE_ALREADY]
const ITEST_SITE = 'writes-itest.example'
const REQUEST_WEBSITE = 'writes-itest-request.example'
// A fixed past stamp so "did the write bump updated_at?" is unambiguous.
const FIXED_PAST = new Date('2020-01-01T00:00:00.000Z')

async function insertCoupon(
    id: string,
    over: { expired?: boolean; timesUsed?: number } = {},
) {
    await prisma.coupon.create({
        data: {
            id,
            code: `WRITE-ITEST-${id}`,
            site: ITEST_SITE,
            title: 'writes itest coupon',
            description: 'synthetic row for the W4-D2 write itest',
            // NOT 'valid' — stays out of getCouponStats' status='valid' census
            // that coupons-read.itest.ts asserts on.
            status: 'pending',
            expired: over.expired ?? false,
            timesUsed: over.timesUsed ?? 0,
            // Coupon.updatedAt is a PLAIN @default(now()) (not @updatedAt), so an
            // explicit past value sticks — only expireCoupons' SET updated_at =
            // NOW() should move it.
            updatedAt: FIXED_PAST,
        },
    })
}

async function cleanup() {
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.coupon.deleteMany({ where: { id: { in: ALL_COUPON_IDS } } })
    await prisma.source.deleteMany({ where: { source: REQUEST_WEBSITE } })
}

afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('recordUsage (real pg :28005) — app-owned counter, catalog untouched', () => {
    it('bumps coupon_signal.workCount (no timestamp) and never touches coupons.times_used / updated_at', async () => {
        await insertCoupon(USAGE_ID, { timesUsed: 5 })
        const before = await prisma.coupon.findUnique({
            where: { id: USAGE_ID },
        })

        await recordUsage(USAGE_ID)

        // Signal bumped, keyed independently of the catalog row; a use is NOT a
        // trust "worked-at" stamp, so lastWorkedAt stays null.
        const sig1 = await prisma.couponSignal.findUnique({
            where: { couponId: USAGE_ID },
        })
        expect(sig1?.workCount).toBe(1)
        expect(sig1?.lastWorkedAt).toBeNull()

        // The catalog row is UNTOUCHED — the whole reason usage telemetry left
        // the catalog (a times_used/updated_at bump would freeze the row under
        // the ingest only-if-newer rule, RULING C′).
        const after = await prisma.coupon.findUnique({
            where: { id: USAGE_ID },
        })
        expect(after?.timesUsed).toBe(5)
        expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())

        // A second use increments the same key.
        await recordUsage(USAGE_ID)
        const sig2 = await prisma.couponSignal.findUnique({
            where: { couponId: USAGE_ID },
        })
        expect(sig2?.workCount).toBe(2)
    })
})

describe('expireCoupons (real pg :28005) — app-catalog UPDATE', () => {
    it('expires only currently-live rows (count = FALSE→TRUE), stamps expiry + updated_at, skips already-expired', async () => {
        await insertCoupon(EXPIRE_LIVE_A)
        await insertCoupon(EXPIRE_LIVE_B)
        await insertCoupon(EXPIRE_ALREADY, { expired: true })
        const alreadyBefore = await prisma.coupon.findUnique({
            where: { id: EXPIRE_ALREADY },
        })

        const count = await expireCoupons([
            EXPIRE_LIVE_A,
            EXPIRE_LIVE_B,
            EXPIRE_ALREADY,
        ])

        // Only the two live rows transitioned — the already-expired one is
        // excluded by the `AND expired = FALSE` guard, so the count is exactly
        // the FALSE→TRUE transitions (the old RETURNING-id rows.length).
        expect(count).toBe(2)

        for (const id of [EXPIRE_LIVE_A, EXPIRE_LIVE_B]) {
            const row = await prisma.coupon.findUnique({ where: { id } })
            expect(row?.expired).toBe(true)
            expect(row?.expiry).toEqual(expect.any(String)) // NOW()::text
            expect(row!.updatedAt.getTime()).toBeGreaterThan(
                FIXED_PAST.getTime(),
            )
        }

        // The already-expired row was NOT re-written — its updated_at is
        // unchanged (proves the WHERE guard, and that a re-expire is a no-op).
        const alreadyAfter = await prisma.coupon.findUnique({
            where: { id: EXPIRE_ALREADY },
        })
        expect(alreadyAfter?.expired).toBe(true)
        expect(alreadyAfter!.updatedAt.getTime()).toBe(
            alreadyBefore!.updatedAt.getTime(),
        )
    })

    it('an empty id list is a no-op (returns 0, issues no SQL)', async () => {
        await expect(expireCoupons([])).resolves.toBe(0)
    })
})

describe('requestSource (real pg :28005) — app sources INSERT', () => {
    it('creates a REQUESTED sources row with the website, an empty websites[], and a minted id', async () => {
        await requestSource(REQUEST_WEBSITE)

        const rows = await prisma.source.findMany({
            where: { source: REQUEST_WEBSITE },
        })
        expect(rows).toHaveLength(1)
        const row = rows[0]!
        expect(row.source).toBe(REQUEST_WEBSITE)
        expect(row.websites).toEqual([])
        expect(row.status).toBe('REQUESTED')
        // Source.id has no DB default — requestSource mints one app-side.
        expect(typeof row.id).toBe('string')
        expect(row.id.length).toBeGreaterThan(0)
    })

    it('returns duplicate for a host that already has a row (unique constraint)', async () => {
        await requestSource(REQUEST_WEBSITE)
        const second = await requestSource(REQUEST_WEBSITE)
        expect(second).toBe('duplicate')

        const rows = await prisma.source.findMany({
            where: { source: REQUEST_WEBSITE },
        })
        expect(rows).toHaveLength(1)
    })
})
