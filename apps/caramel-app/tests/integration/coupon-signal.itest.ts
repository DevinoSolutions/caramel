import {
    attachSignals,
    recordFailed,
    recordWorked,
    reporterHash,
} from '@/lib/couponSignals'
import prisma from '@/lib/prisma'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

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
const ALL_IDS = [WORKED_ID, FAILED_ID, SEEDED_ID, UNSEEDED_ID]

async function cleanup() {
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_IDS } },
    })
}

afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('couponSignals (real prisma, live pg :58005)', () => {
    it('recordWorked stamps lastWorkedAt and leaves workCount at 0 (W4-D2 split — increment owns the counter)', async () => {
        await recordWorked(WORKED_ID)
        const first = await prisma.couponSignal.findUnique({
            where: { couponId: WORKED_ID },
        })
        expect(first?.lastWorkedAt).toBeInstanceOf(Date)
        expect(first?.workCount).toBe(0)

        // A second worked-report re-stamps lastWorkedAt without ever bumping
        // workCount — recordUsage (POST /increment) is the only counter writer.
        await recordWorked(WORKED_ID)
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

    it('attachSignals returns lastWorkedAt (ISO) for a seeded id and null for an unseeded one', async () => {
        await recordWorked(SEEDED_ID)
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
