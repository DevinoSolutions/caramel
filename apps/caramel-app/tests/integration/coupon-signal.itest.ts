import {
    attachSignals,
    recordFailed,
    recordUsage,
    recordWorked,
    reporterHash,
} from '@/lib/couponSignals'
import prisma from '@/lib/prisma'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// W1 integration — recordWorked / recordFailed / attachSignals exercised
// against the REAL prisma client + a live local Postgres (:58005). Assumes the
// DB is migrated (the harness/CI runs `prisma migrate deploy` first). Uses
// synthetic coupon ids in a private 999000xxx range so they never collide with
// real catalog ids, and deletes them after each test so the suite is
// idempotent and re-runnable.
const WORKED_ID = '999000001'
const FAILED_ID = '999000002'
const SEEDED_ID = '999000003'
const UNSEEDED_ID = '999000004'
const ABSENT_ID = '999000005' // never inserted into the catalog
const CATALOG_IDS = [WORKED_ID, FAILED_ID, SEEDED_ID, UNSEEDED_ID]
const ALL_IDS = [...CATALOG_IDS, ABSENT_ID]

// coupon_signals has no FK, so the aggregate write gates itself on a catalog row
// (couponsRepo.writeCouponSignal: INSERT ... SELECT ... WHERE EXISTS): every id a
// writer is expected to record needs a real `coupons` row. 'pending' keeps these
// synthetic rows out of the status='valid' census other suites count.
async function insertCoupon(id: string) {
    await prisma.coupon.create({
        data: {
            id,
            code: `SIGNAL-ITEST-${id}`,
            site: 'coupon-signal-itest.example',
            title: 'coupon signal itest coupon',
            description: 'synthetic row for the coupon_signals itest',
            status: 'pending',
        },
    })
}

async function cleanup() {
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.coupon.deleteMany({ where: { id: { in: ALL_IDS } } })
}

beforeEach(async () => {
    await cleanup()
    for (const id of CATALOG_IDS) await insertCoupon(id)
})
afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

// An ESTABLISHED account stamps lastWorkedAt on its own say-so; an anonymous
// network or a young account NEVER does (tested below).
const ESTABLISHED = {
    kind: 'user',
    userId: 'itest-established-account',
    established: true,
} as const

describe('couponSignals (real prisma, live pg :58005)', () => {
    it('LOW-TRUST worked reports NEVER stamp lastWorkedAt, however many distinct reporters, and store nothing about them (real pg)', async () => {
        const anon = (n: number) =>
            ({ kind: 'ip', ip: `203.0.113.${n}` }) as const
        for (let n = 1; n <= 10; n++) {
            expect(await recordWorked(WORKED_ID, anon(n))).toBe(true)
        }
        await recordWorked(WORKED_ID, {
            kind: 'user',
            userId: 'itest-young-account',
            established: false,
        })
        // An established account over its daily cap is demoted to low-trust.
        await recordWorked(WORKED_ID, ESTABLISHED, undefined, { demote: true })

        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: WORKED_ID },
        })
        // The existence gate created the row, but no stamp.
        expect(row.lastWorkedAt).toBeNull()
        expect(row.workCount).toBe(0)
        expect(
            await prisma.couponSignalReporter.count({
                where: { couponId: WORKED_ID },
            }),
        ).toBe(0)
    })

    it('a low-trust worked report on an id that is not a catalog row writes no reporter row (real pg)', async () => {
        expect(
            await recordWorked(ABSENT_ID, { kind: 'ip', ip: '203.0.113.9' }),
        ).toBe(false)
        expect(
            await prisma.couponSignalReporter.count({
                where: { couponId: ABSENT_ID },
            }),
        ).toBe(0)
    })

    it('recordWorked stamps lastWorkedAt and leaves workCount at 0 (W4-D2 split — increment owns the counter)', async () => {
        await recordWorked(WORKED_ID, ESTABLISHED)
        const first = await prisma.couponSignal.findUnique({
            where: { couponId: WORKED_ID },
        })
        expect(first?.lastWorkedAt).toBeInstanceOf(Date)
        expect(first?.workCount).toBe(0)

        // A second worked-report re-stamps lastWorkedAt without ever bumping
        // workCount — recordUsage (POST /increment) is the only counter writer.
        await recordWorked(WORKED_ID, ESTABLISHED)
        const second = await prisma.couponSignal.findUnique({
            where: { couponId: WORKED_ID },
        })
        expect(second?.lastWorkedAt).toBeInstanceOf(Date)
        expect(second?.workCount).toBe(0)
    })

    it('recordFailed sets failCount, failWeight, lastFailedAt and lastFailReason, and stores a hashed reporter', async () => {
        const reporter = { kind: 'ip', ip: '203.0.113.50' } as const
        await recordFailed(FAILED_ID, 'Minimum spend not met', reporter)
        const row = await prisma.couponSignal.findUnique({
            where: { couponId: FAILED_ID },
        })
        expect(row?.failCount).toBe(1)
        expect(row?.failWeight).toBe(1)
        expect(row?.lastFailedAt).toBeInstanceOf(Date)
        expect(row?.lastFailReason).toBe('Minimum spend not met')
        const reporters = await prisma.couponSignalReporter.findMany({
            where: { couponId: FAILED_ID },
        })
        expect(reporters).toHaveLength(1)
        expect(reporters[0]?.reporterHash).toBe(reporterHash(reporter))
        expect(reporters[0]?.reporterHash).not.toContain('203.0.113')
    })

    it('the same reporter failing a coupon twice is ONE reporter in the quorum', async () => {
        const reporter = { kind: 'ip', ip: '203.0.113.51' } as const
        await recordFailed(FAILED_ID, null, reporter)
        await recordFailed(FAILED_ID, null, reporter)
        const row = await prisma.couponSignal.findUnique({
            where: { couponId: FAILED_ID },
        })
        expect(row?.failCount).toBe(2)
        expect(row?.failWeight).toBe(1)
    })

    it('the raw upsert stamps UTC wall-clock times: Prisma reads lastWorkedAt, createdAt and updatedAt back as now, whatever the session timezone', async () => {
        await recordWorked(WORKED_ID, ESTABLISHED)
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: WORKED_ID },
        })
        for (const stamp of [row.lastWorkedAt, row.createdAt, row.updatedAt]) {
            expect(Math.abs(stamp!.getTime() - Date.now())).toBeLessThan(
                5 * 60 * 1000,
            )
        }
    })

    it('recordUsage bumps workCount once per use and stamps nothing else on the trust side', async () => {
        expect(await recordUsage(WORKED_ID)).toBe(true)
        expect(await recordUsage(WORKED_ID)).toBe(true)
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: WORKED_ID },
        })
        expect(row.workCount).toBe(2)
        expect(row.lastWorkedAt).toBeNull()
        expect(row.failCount).toBe(0)
    })

    it('an id that is not a catalog row: all three writers resolve false and leave NO signal row and NO reporter row', async () => {
        const reporter = { kind: 'ip', ip: '203.0.113.60' } as const

        expect(await recordWorked(ABSENT_ID, reporter)).toBe(false)
        expect(await recordFailed(ABSENT_ID, 'min spend', reporter)).toBe(false)
        expect(await recordUsage(ABSENT_ID)).toBe(false)

        expect(
            await prisma.couponSignal.findUnique({
                where: { couponId: ABSENT_ID },
            }),
        ).toBeNull()
        expect(
            await prisma.couponSignalReporter.count({
                where: { couponId: ABSENT_ID },
            }),
        ).toBe(0)
    })

    it('the latest failed report replaces the earlier reason, a null reason included', async () => {
        const first = { kind: 'ip', ip: '203.0.113.61' } as const
        const second = { kind: 'ip', ip: '203.0.113.62' } as const
        await recordFailed(FAILED_ID, 'Expired code', first)
        await recordFailed(FAILED_ID, null, second)
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: FAILED_ID },
        })
        expect(row.failCount).toBe(2)
        expect(row.lastFailReason).toBeNull()
    })

    it('attachSignals returns lastWorkedAt (ISO) for a seeded id and null for an unseeded one', async () => {
        await recordWorked(SEEDED_ID, ESTABLISHED)
        const seeded = await prisma.couponSignal.findUnique({
            where: { couponId: SEEDED_ID },
        })

        const out = await attachSignals([
            { id: SEEDED_ID },
            { id: UNSEEDED_ID },
        ])

        expect(out).toEqual([
            {
                id: SEEDED_ID,
                lastWorkedAt: seeded?.lastWorkedAt?.toISOString() ?? null,
                lastFailedAt: null,
                failCount: 0,
                failWeight: 0,
                keepsFailing: false,
            },
            {
                id: UNSEEDED_ID,
                lastWorkedAt: null,
                lastFailedAt: null,
                failCount: 0,
                failWeight: 0,
                keepsFailing: false,
            },
        ])
        // Sanity: the seeded id really resolved to a non-null ISO string, not
        // a vacuous null-equals-null match.
        expect(out[0]!.lastWorkedAt).toEqual(expect.any(String))
    })
})
