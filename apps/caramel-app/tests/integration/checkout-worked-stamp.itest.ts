import { stampCheckoutWorked } from '@/lib/checkoutWorkedStamp'
import { resetReportDedupeForTests } from '@/lib/couponReportDedupe'
import { resetReportVelocityForTests } from '@/lib/couponReportVelocity'
import { lockShopperUser } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

// stampCheckoutWorked (T-6222) against REAL Postgres + the real prisma client:
// the per-account daily cap counted from coupon_reports, the persisted 24h
// dedupe, the advisory lock that stops two concurrent requests both passing the
// same count, and the transaction that makes the stamp and its attribution row
// one unit. The unit suite proves the route's wiring against a fake table; only
// Postgres can prove the lock, the FK and the rollback.
//
// Private id/email ranges (700072xxx coupons, a stamp-itest.example site and
// users) that no seed row and no other integration file touches. Everything is
// deleted after each test.
const SITE = 'stamp-itest.example'
const TARGET = '700072001'
const OTHER = '700072002'
const FILLER_FIRST = 700072100
const DAILY_CAP = 30 // COUPON_WORKED_STAMPS_PER_USER_PER_DAY default
const EMAIL = 'stamp-itest@example.com'
const EMAIL_B = 'stamp-itest-b@example.com'
const OLD_ACCOUNT = new Date('2026-01-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const fillerIds = (count: number) =>
    Array.from({ length: count }, (_, n) => String(FILLER_FIRST + n))
const ALL_IDS = [TARGET, OTHER, ...fillerIds(DAILY_CAP + 8)]

let userId = ''
let otherUserId = ''

async function cleanup() {
    await prisma.couponReport.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.coupon.deleteMany({ where: { id: { in: ALL_IDS } } })
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, EMAIL_B] } } })
}

async function insertCoupons(ids: string[]) {
    await prisma.coupon.createMany({
        data: ids.map(id => ({
            id,
            code: `STAMP-ITEST-${id}`,
            site: SITE,
            title: 'stamp itest coupon',
            description: 'synthetic row for the checkout worked-stamp itest',
            // NOT 'valid': stays out of the status='valid' census elsewhere.
            status: 'pending',
        })),
    })
}

/** `count` worked attributions for `forUserId`, on filler coupons, `ageMs` old. */
async function seedStamps(
    forUserId: string,
    count: number,
    ageMs = 60_000,
    outcome = 'worked',
) {
    await prisma.couponReport.createMany({
        data: fillerIds(count).map(couponId => ({
            couponId,
            userId: forUserId,
            outcome,
            createdAt: new Date(Date.now() - ageMs),
        })),
    })
}

const stamp = (couponId: string, who = userId, submittedByUser = false) =>
    stampCheckoutWorked({
        couponId,
        userId: who,
        accountCreatedAt: OLD_ACCOUNT,
        submittedByUser,
    })

const reportRows = (couponId: string) =>
    prisma.couponReport.findMany({ where: { couponId } })

const lastWorkedAt = async (couponId: string) =>
    (await prisma.couponSignal.findUnique({ where: { couponId } }))
        ?.lastWorkedAt ?? null

beforeEach(async () => {
    resetReportDedupeForTests()
    resetReportVelocityForTests()
    await cleanup()
    userId = (await prisma.user.create({ data: { email: EMAIL } })).id
    otherUserId = (await prisma.user.create({ data: { email: EMAIL_B } })).id
    await insertCoupons([TARGET, OTHER, ...fillerIds(DAILY_CAP + 8)])
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('stampCheckoutWorked (real pg)', () => {
    it('stamps last_worked_at and writes exactly one attribution row, in one transaction', async () => {
        expect(await stamp(TARGET)).toBe('stamped')

        expect(await lastWorkedAt(TARGET)).toBeInstanceOf(Date)
        const rows = await reportRows(TARGET)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ userId, outcome: 'worked' })
    })

    it('a young account that did not list the code is gated: nothing is written', async () => {
        const outcome = await stampCheckoutWorked({
            couponId: TARGET,
            userId,
            accountCreatedAt: new Date(),
            submittedByUser: false,
        })

        expect(outcome).toBe('gated')
        expect(await lastWorkedAt(TARGET)).toBeNull()
        expect(await reportRows(TARGET)).toHaveLength(0)
    })

    it('a young account may stamp a code it listed itself, and the stamp is real', async () => {
        const outcome = await stampCheckoutWorked({
            couponId: TARGET,
            userId,
            accountCreatedAt: new Date(),
            submittedByUser: true,
        })

        expect(outcome).toBe('stamped')
        expect(await lastWorkedAt(TARGET)).toBeInstanceOf(Date)
    })

    it('PERSISTED dedupe: after a restart (empty in-memory state) a repeat inside 24h is not re-stamped and adds no row', async () => {
        await stamp(TARGET)
        const first = await lastWorkedAt(TARGET)
        await new Promise(resolve => setTimeout(resolve, 20))
        resetReportDedupeForTests()
        resetReportVelocityForTests()

        expect(await stamp(TARGET)).toBe('deduped')

        expect(await lastWorkedAt(TARGET)).toEqual(first)
        expect(await reportRows(TARGET)).toHaveLength(1)
    })

    it('a stamp older than 24h does not dedupe: the account may vouch again', async () => {
        await prisma.couponReport.create({
            data: {
                couponId: TARGET,
                userId,
                outcome: 'worked',
                createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            },
        })

        expect(await stamp(TARGET)).toBe('stamped')
        expect(await reportRows(TARGET)).toHaveLength(2)
    })

    // N3: POST /api/coupons/<id>/report keeps a 'worked' attribution row even
    // when the report moved nothing (a low-trust or over-cap account). Only a
    // row whose stamp really happened may dedupe the capture.
    it('an attribution row with NO stamp behind it does not dedupe: the capture stamps and reuses the row', async () => {
        await prisma.couponReport.create({
            data: {
                couponId: TARGET,
                userId,
                outcome: 'worked',
                createdAt: new Date(Date.now() - 60 * 60 * 1000),
            },
        })

        expect(await stamp(TARGET)).toBe('stamped')

        expect(await lastWorkedAt(TARGET)).toBeInstanceOf(Date)
        expect(await reportRows(TARGET)).toHaveLength(1)
    })

    it("an attribution row whose coupon carries only SOMEBODY ELSE's older stamp does not dedupe either", async () => {
        const hoursAgo = (hours: number) =>
            new Date(Date.now() - hours * 60 * 60 * 1000)
        await prisma.couponReport.create({
            data: {
                couponId: TARGET,
                userId,
                outcome: 'worked',
                createdAt: hoursAgo(1),
            },
        })
        await prisma.couponSignal.create({
            data: { couponId: TARGET, lastWorkedAt: hoursAgo(5), workCount: 1 },
        })

        expect(await stamp(TARGET)).toBe('stamped')

        const stamped = await lastWorkedAt(TARGET)
        expect(stamped?.getTime()).toBeGreaterThan(hoursAgo(1).getTime())
        expect(await reportRows(TARGET)).toHaveLength(1)
    })

    it('DAILY CAP: an account at the cap stamps nothing more; the refusal writes nothing and moves nothing', async () => {
        await seedStamps(userId, DAILY_CAP)

        expect(await stamp(TARGET)).toBe('capped')

        expect(await lastWorkedAt(TARGET)).toBeNull()
        expect(await reportRows(TARGET)).toHaveLength(0)

        // Once the day's stamps age out, the same account can stamp this code
        // (the refusal left no dedupe state behind).
        await prisma.couponReport.updateMany({
            where: { userId },
            data: { createdAt: new Date(Date.now() - 2 * DAY) },
        })
        expect(await stamp(TARGET)).toBe('stamped')
    })

    it('DAILY CAP: one below the cap still stamps, and rows of other accounts, other outcomes and older than 24h are not counted', async () => {
        await seedStamps(userId, DAILY_CAP - 1)
        expect(await stamp(TARGET)).toBe('stamped')

        await prisma.couponReport.deleteMany({
            where: { couponId: { in: ALL_IDS } },
        })
        await seedStamps(otherUserId, DAILY_CAP)
        await seedStamps(userId, DAILY_CAP, 60_000, 'failed')
        await prisma.couponReport.createMany({
            data: fillerIds(DAILY_CAP).map(couponId => ({
                couponId,
                userId,
                outcome: 'worked',
                createdAt: new Date(Date.now() - 2 * DAY),
            })),
        })
        expect(await stamp(OTHER)).toBe('stamped')
    })

    it('the per-account advisory lock: a stamp WAITS while another transaction of the same account holds the shopper lock, and counts only after it commits', async () => {
        await seedStamps(userId, DAILY_CAP - 1)
        let settled = false
        let pending: Promise<unknown> = Promise.resolve()

        await prisma.$transaction(async tx => {
            await lockShopperUser(tx, userId)
            pending = stamp(TARGET).finally(() => {
                settled = true
            })
            // Plenty of time for an UNLOCKED stamp to finish (they take ~50ms).
            await new Promise(resolve => setTimeout(resolve, 600))
            expect(settled).toBe(false)
            // The holder takes the last slot under the cap, as a concurrent
            // submit of the same account would.
            await tx.couponReport.create({
                data: { couponId: OTHER, userId, outcome: 'worked' },
            })
        })

        // With the lock released the waiter counts the holder's committed row
        // and finds the cap spent: it cannot have read a stale 29.
        expect(await pending).toBe('capped')
        expect(await lastWorkedAt(TARGET)).toBeNull()
    })

    it('a stamp for ANOTHER account is not blocked by the lock another account holds', async () => {
        await prisma.$transaction(async tx => {
            await lockShopperUser(tx, userId)
            expect(await stamp(TARGET, otherUserId)).toBe('stamped')
        })
    })

    it('ROLLBACK: when the attribution insert fails (no such user, a real FK), the stamp is rolled back with it and the retry works', async () => {
        const ghost = 'stamp-itest-no-such-user'

        await expect(stamp(TARGET, ghost)).rejects.toThrow()

        // coupon_signals carries no FK, so a stamp that was NOT rolled back
        // would be right here.
        expect(await lastWorkedAt(TARGET)).toBeNull()
        expect(await reportRows(TARGET)).toHaveLength(0)

        // The failed attempt gave its slots back: a real account stamps fine.
        expect(await stamp(TARGET)).toBe('stamped')
        expect(await lastWorkedAt(TARGET)).toBeInstanceOf(Date)
    })

    it('ROLLBACK: a coupon that is not in the catalog throws, writing no signal and no attribution row', async () => {
        await expect(stamp('700072999')).rejects.toThrow(/no catalog row/)

        expect(
            await prisma.couponSignal.findUnique({
                where: { couponId: '700072999' },
            }),
        ).toBeNull()
        expect(await reportRows('700072999')).toHaveLength(0)
    })

    it('the (user_id, outcome, created_at) index exists, so the daily count is an index range scan', async () => {
        const rows = await prisma.$queryRaw<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'coupon_reports'
              AND indexname = 'coupon_reports_user_id_outcome_created_at_idx'
        `
        expect(rows).toHaveLength(1)
    })
})
