import { attachSignals, recordFailed, recordWorked } from '@/lib/couponSignals'
import { isRecentlyFailing } from '@/lib/coupons'
import prisma from '@/lib/prisma'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// T-5535 M3 grandfathering, against REAL Postgres: the data migration
// 20261021213000_coupon_failure_quorum_legacy_seed gives every code that was
// sunk/collapsed under the old raw-count rule one synthetic 'legacy' reporter
// row, so it stays sunk/collapsed until it ages out or a success clears it.
// The test seeds rows in the pre-quorum shape (fail_weight 0), runs the
// migration's OWN statements (read from the .sql file, so the shipped SQL is
// what is tested) and then drives the real couponSignals writers.
//
// Private id range 988100xxx; everything is removed before and after.

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const COLLAPSED = '988100001' // 3 recent failures, never worked
const SUNK = '988100002' // 2 recent failures, never worked
const OLD = '988100003' // failures all older than the window
const SUCCEEDED = '988100004' // a success after the last failure
const NOISE = '988100005' // one failure
const IDS = [COLLAPSED, SUNK, OLD, SUCCEEDED, NOISE]

const MIGRATION_SQL = readFileSync(
    join(
        __dirname,
        '../../prisma/migrations/20261021213000_coupon_failure_quorum_legacy_seed/migration.sql',
    ),
    'utf8',
)

async function cleanup() {
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: IDS } },
    })
    await prisma.couponSignal.deleteMany({ where: { couponId: { in: IDS } } })
}

async function runMigrationSeed() {
    const statements = MIGRATION_SQL.split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map(statement => statement.trim())
        .filter(Boolean)
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement)
    }
}

const reporter = (n: number) => ({ kind: 'ip', ip: `203.0.113.${n}` }) as const

async function overlay(id: string) {
    const [row] = await attachSignals([{ id }])
    return row!
}

beforeAll(async () => {
    await cleanup()
    const now = Date.now()
    const seed = (
        couponId: string,
        failCount: number,
        failedAgo: number,
        workedAgo?: number,
    ) =>
        prisma.couponSignal.create({
            data: {
                couponId,
                failCount,
                failWeight: 0,
                lastFailedAt: new Date(now - failedAgo),
                lastWorkedAt:
                    workedAgo === undefined ? null : new Date(now - workedAgo),
            },
        })
    await seed(COLLAPSED, 3, HOUR)
    await seed(SUNK, 2, 2 * HOUR)
    await seed(OLD, 5, 40 * DAY)
    await seed(SUCCEEDED, 4, 3 * DAY, 2 * DAY)
    await seed(NOISE, 1, HOUR)
    await runMigrationSeed()
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('legacy sunk codes are grandfathered by the data migration (real pg)', () => {
    it('seeds one legacy reporter only for codes that were sunk under the old rule, at the old thresholds', async () => {
        const rows = await prisma.couponSignalReporter.findMany({
            where: { couponId: { in: IDS } },
            orderBy: { couponId: 'asc' },
        })
        expect(rows.map(r => [r.couponId, r.reporterHash, r.weight])).toEqual([
            [COLLAPSED, 'legacy', 6],
            [SUNK, 'legacy', 4],
        ])
        const weights = await prisma.couponSignal.findMany({
            where: { couponId: { in: IDS } },
            orderBy: { couponId: 'asc' },
            select: { couponId: true, failWeight: true },
        })
        expect(weights.map(w => [w.couponId, w.failWeight])).toEqual([
            [COLLAPSED, 6],
            [SUNK, 4],
            [OLD, 0],
            [SUCCEEDED, 0],
            [NOISE, 0],
        ])
    })

    it('a legacy collapsed code stays collapsed and a legacy sunk code stays sunk (and not collapsed)', async () => {
        const collapsed = await overlay(COLLAPSED)
        expect(collapsed.keepsFailing).toBe(true)
        const sunk = await overlay(SUNK)
        expect(isRecentlyFailing(sunk)).toBe(true)
        expect(sunk.failWeight).toBe(4)
        expect(sunk.keepsFailing).toBe(false)
        expect((await overlay(OLD)).failWeight).toBe(0)
        expect((await overlay(NOISE)).failWeight).toBe(0)
    })

    it('a new report goes through the quorum on top of the legacy weight; the legacy row survives it', async () => {
        await recordFailed(SUNK, null, reporter(1))
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: SUNK },
        })
        expect(row.failWeight).toBe(5)
        expect(
            await prisma.couponSignalReporter.count({
                where: { couponId: SUNK },
            }),
        ).toBe(2)
    })

    it('one anonymous success does NOT clear a legacy quorum; a second distinct reporter does, and later failures count afresh', async () => {
        await recordWorked(COLLAPSED, reporter(2))
        expect(
            (
                await prisma.couponSignal.findUniqueOrThrow({
                    where: { couponId: COLLAPSED },
                })
            ).failWeight,
        ).toBe(6)

        await recordWorked(COLLAPSED, reporter(3))
        const cleared = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: COLLAPSED },
        })
        expect(cleared.failWeight).toBe(0)
        expect((await overlay(COLLAPSED)).keepsFailing).toBe(false)

        await new Promise(resolve => setTimeout(resolve, 20))
        await recordFailed(COLLAPSED, null, reporter(4))
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: COLLAPSED },
        })
        expect(row.failWeight).toBe(1)
    })

    it('a success on a code with no failure quorum stores nothing about its reporter', async () => {
        await recordWorked(NOISE, reporter(5))
        expect(
            await prisma.couponSignalReporter.count({
                where: { couponId: NOISE },
            }),
        ).toBe(0)
        expect(
            (
                await prisma.couponSignal.findUniqueOrThrow({
                    where: { couponId: NOISE },
                })
            ).lastWorkedAt,
        ).not.toBeNull()
    })

    it('it ages out on its own after the 30-day window, and its row is pruned', async () => {
        await prisma.couponSignalReporter.updateMany({
            where: { couponId: SUNK },
            data: { lastAt: new Date(Date.now() - 31 * DAY) },
        })
        await prisma.couponSignal.update({
            where: { couponId: SUNK },
            data: { lastFailedAt: new Date(Date.now() - 31 * DAY) },
        })
        // Aged out even before any new report: the SQL/TS predicate checks the
        // 30-day window on last_failed_at.
        expect(isRecentlyFailing(await overlay(SUNK))).toBe(false)

        await recordFailed(SUNK, null, reporter(3))
        const row = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: SUNK },
        })
        expect(row.failWeight).toBe(1)
        const left = await prisma.couponSignalReporter.findMany({
            where: { couponId: SUNK },
        })
        expect(left.map(r => r.reporterHash)).not.toContain('legacy')
    })
})
