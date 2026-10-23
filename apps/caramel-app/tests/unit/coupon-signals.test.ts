import type { ReportReporter } from '@/lib/couponReportDedupe'
import { attachSignals, recordUsage, recordWorked } from '@/lib/couponSignals'
import * as Sentry from '@sentry/nextjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// couponSignals unit pins. Mocks @/lib/prisma (the app Postgres the signal
// table lives in) so each writer/merger is tested in isolation. The aggregate
// write is ONE raw `INSERT ... SELECT ... WHERE EXISTS (catalog row) ON
// CONFLICT` statement (couponsRepo.writeWorkedSignal / writeUsageSignal), so
// its pins read the composed `.sql`; an empty result is an id that is not a
// catalog row:
//   * attachSignals — the "merge, not SQL join" boundary (empty-in short-
//     circuits, matching ids → ISO string, unheld/null → null).
//   * recordWorked / recordUsage — the W4-D2 field split: each upsert owns
//     exactly one field so a successful apply (report{worked} + increment)
//     never double-counts.
const { prismaMock, signalState } = vi.hoisted(() => {
    const signalState = {
        rows: [] as {
            couponId: string
            lastWorkedAt: Date | null
            lastFailedAt?: Date | null
            failCount?: number
            failWeight?: number
        }[],
    }
    return {
        signalState,
        prismaMock: {
            couponSignal: {
                findMany: vi.fn(
                    async (_args: { where: unknown; select: unknown }) =>
                        signalState.rows,
                ),
            },
            $queryRaw: vi.fn(
                async (_query: {
                    sql: string
                    values: unknown[]
                }): Promise<unknown[]> => [{ failWeight: 0 }],
            ),
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

const NO_SIGNAL = {
    lastWorkedAt: null,
    lastFailedAt: null,
    failCount: 0,
    failWeight: 0,
    keepsFailing: false,
}

beforeEach(() => {
    signalState.rows = []
    prismaMock.couponSignal.findMany.mockClear()
    prismaMock.$queryRaw.mockClear()
})

describe('attachSignals (app-owned lastWorkedAt merge)', () => {
    it('empty input → empty output, no query issued', async () => {
        const out = await attachSignals([])

        expect(out).toEqual([])
        expect(prismaMock.couponSignal.findMany).not.toHaveBeenCalled()
    })

    it('attaches lastWorkedAt (ISO string) for a matching id, null for an unmatched one', async () => {
        const worked = new Date('2026-07-14T10:00:00.000Z')
        signalState.rows = [{ couponId: '1', lastWorkedAt: worked }]

        const out = await attachSignals([
            { id: '1', code: 'A' },
            { id: '2', code: 'B' },
        ])

        expect(out).toEqual([
            {
                id: '1',
                code: 'A',
                lastWorkedAt: worked.toISOString(),
                lastFailedAt: null,
                failCount: 0,
                failWeight: 0,
                keepsFailing: false,
            },
            { id: '2', code: 'B', ...NO_SIGNAL },
        ])
    })

    it('attaches the failure side (lastFailedAt ISO string + failCount) beside lastWorkedAt', async () => {
        const failed = new Date(Date.now() - 60 * 60 * 1000)
        signalState.rows = [
            {
                couponId: '1',
                lastWorkedAt: null,
                lastFailedAt: failed,
                failCount: 4,
                failWeight: 6,
            },
        ]

        const out = await attachSignals([{ id: '1' }])

        expect(out[0]).toEqual({
            id: '1',
            lastWorkedAt: null,
            lastFailedAt: failed.toISOString(),
            failCount: 4,
            failWeight: 6,
            // A collapse-level quorum, the latest recent, no success since.
            keepsFailing: true,
        })
    })

    it('keepsFailing is false for a sink-only quorum (weight 4) and for a cleared quorum (weight 0), true at the collapse weight even with a later worked stamp', async () => {
        const failed = new Date(Date.now() - 60 * 60 * 1000)
        const workedAfter = new Date(Date.now() - 60 * 1000)
        signalState.rows = [
            {
                couponId: '1',
                lastWorkedAt: null,
                lastFailedAt: failed,
                failCount: 2,
                failWeight: 4,
            },
            {
                couponId: '2',
                lastWorkedAt: null,
                lastFailedAt: failed,
                failCount: 3,
                failWeight: 6,
            },
            // A worked stamp alone clears nothing (one forged success must not
            // undo the quorum): only the worked quorum folded into failWeight does.
            {
                couponId: '3',
                lastWorkedAt: workedAfter,
                lastFailedAt: failed,
                failCount: 9,
                failWeight: 12,
            },
            {
                couponId: '4',
                lastWorkedAt: workedAfter,
                lastFailedAt: failed,
                failCount: 9,
                failWeight: 0,
            },
        ]

        const out = await attachSignals([
            { id: '1' },
            { id: '2' },
            { id: '3' },
            { id: '4' },
        ])

        expect(out.map(c => c.keepsFailing)).toEqual([false, true, true, false])
    })

    it('selects the failure columns but NOT the free-text lastFailReason', async () => {
        await attachSignals([{ id: '1' }])

        const arg = prismaMock.couponSignal.findMany.mock.calls[0]![0]
        expect(arg.select).toEqual({
            couponId: true,
            lastWorkedAt: true,
            lastFailedAt: true,
            failCount: true,
            failWeight: true,
        })
    })

    it('a signal row with a null lastWorkedAt (failures only) resolves to null', async () => {
        signalState.rows = [{ couponId: '1', lastWorkedAt: null }]

        const out = await attachSignals([{ id: '1' }])

        expect(out[0]!.lastWorkedAt).toBeNull()
    })

    it('queries only the ids on the page (findMany where couponId in ids)', async () => {
        await attachSignals([{ id: '7' }, { id: '9' }])

        expect(prismaMock.couponSignal.findMany).toHaveBeenCalledTimes(1)
        const arg = prismaMock.couponSignal.findMany.mock.calls[0]![0]
        expect(arg.where).toEqual({ couponId: { in: ['7', '9'] } })
    })

    it('a findMany failure (e.g. unmigrated env) degrades to lastWorkedAt:null and reports to Sentry — never throws', async () => {
        prismaMock.couponSignal.findMany.mockRejectedValueOnce(
            new Error('relation "coupon_signals" does not exist'),
        )
        vi.mocked(Sentry.captureException).mockClear()
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const out = await attachSignals([
            { id: '1', code: 'A' },
            { id: '2', code: 'B' },
        ])

        expect(out).toEqual([
            { id: '1', code: 'A', ...NO_SIGNAL },
            { id: '2', code: 'B', ...NO_SIGNAL },
        ])
        expect(Sentry.captureException).toHaveBeenCalledTimes(1)

        warnSpy.mockRestore()
    })
})

describe('recordWorked (owns lastWorkedAt ONLY — W4-D2 split)', () => {
    const anon: ReportReporter = { kind: 'ip', ip: '203.0.113.9' }
    // An ESTABLISHED account stamps on its own say-so; an anonymous network does
    // not (see the low-trust tests below).
    const established: ReportReporter = {
        kind: 'user',
        userId: 'user-1',
        established: true,
    }

    /**
     * A transaction client whose coupon_signals row carries `failWeight`
     * (null: the id is not a catalog row, so the aggregate statement returns
     * no row).
     */
    function txWith(failWeight: number | null) {
        return {
            $queryRaw: vi.fn(
                async (_query: {
                    sql: string
                    values: unknown[]
                }): Promise<unknown[]> =>
                    failWeight === null ? [] : [{ failWeight }],
            ),
            couponSignal: {
                update: vi.fn(async () => ({})),
            },
            couponSignalReporter: {
                findMany: vi.fn(async () => []),
                count: vi.fn(async () => 0),
                upsert: vi.fn(
                    async (_args: {
                        create: { outcome: string; weight: number }
                    }) => ({}),
                ),
            },
        }
    }

    it('stamps lastWorkedAt on both insert and conflict in ONE statement, and NEVER touches workCount', async () => {
        const tx = txWith(0)
        expect(await recordWorked('42', established, tx as never)).toBe(true)

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
        const query = tx.$queryRaw.mock.calls[0]![0]
        expect(query.values).toEqual(['42', '42'])
        expect(query.sql).toContain(
            'INSERT INTO coupon_signals (coupon_id, last_worked_at, created_at, updated_at)',
        )
        expect(query.sql).toContain('last_worked_at = EXCLUDED.last_worked_at')
        // The whole point of the split: a "worked" report must not bump the
        // counter, or a successful apply (report + increment) double-counts.
        expect(query.sql).not.toContain('work_count')
    })

    it('an id that is not a catalog row resolves false and stores nothing, not even the reporter', async () => {
        const tx = txWith(null)
        expect(await recordWorked('999', anon, tx as never)).toBe(false)

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
        expect(tx.couponSignalReporter.upsert).not.toHaveBeenCalled()
        expect(tx.couponSignal.update).not.toHaveBeenCalled()
    })

    it('a LOW-TRUST report (anonymous network) does NOT stamp: the statement is the existence gate only, and the reporter is remembered for the quorum', async () => {
        const tx = txWith(0)
        expect(await recordWorked('42', anon, tx as never)).toBe(true)

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
        const query = tx.$queryRaw.mock.calls[0]![0]
        expect(query.sql).not.toContain('last_worked_at')
        expect(query.sql).toContain('updated_at = coupon_signals.updated_at')
        expect(tx.couponSignalReporter.upsert).toHaveBeenCalledTimes(1)
        expect(tx.couponSignalReporter.count).toHaveBeenCalledTimes(1)
        // Quorum not reached (count 0): no recompute without a failure quorum.
        expect(tx.couponSignal.update).not.toHaveBeenCalled()
    })

    it('once the distinct low-trust reporters reach the quorum, a second statement stamps', async () => {
        const tx = txWith(0)
        tx.couponSignalReporter.count.mockResolvedValueOnce(3)
        await recordWorked('42', anon, tx as never)

        expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
        expect(tx.$queryRaw.mock.calls[1]![0].sql).toContain(
            'last_worked_at = EXCLUDED.last_worked_at',
        )
    })

    it('the quorum counts only low-trust (weight below the account weight) worked rows inside the Verified window', async () => {
        const tx = txWith(0)
        await recordWorked('42', anon, tx as never)

        type CountArg = {
            where: {
                couponId: string
                outcome: string
                weight: { lt: number }
                lastAt: { gt: Date }
            }
        }
        const calls = tx.couponSignalReporter.count.mock.calls as unknown as [
            CountArg,
        ][]
        const arg = calls[0]![0]
        expect(arg.where).toMatchObject({
            couponId: '42',
            outcome: 'worked',
            weight: { lt: 2 },
        })
        expect(Date.now() - arg.where.lastAt.gt.getTime()).toBeGreaterThan(
            23 * 60 * 60 * 1000,
        )
    })

    it('forceStamp (the vetted checkout capture) stamps even for a young account', async () => {
        const tx = txWith(0)
        await recordWorked(
            '42',
            { kind: 'user', userId: 'u', established: false },
            tx as never,
            { forceStamp: true },
        )

        expect(tx.$queryRaw.mock.calls[0]![0].sql).toContain(
            'last_worked_at = EXCLUDED.last_worked_at',
        )
        expect(tx.couponSignalReporter.count).not.toHaveBeenCalled()
    })

    it('a coupon with no failure quorum stores nothing about an ESTABLISHED reporter', async () => {
        const tx = txWith(0)
        await recordWorked('42', established, tx as never)

        expect(tx.couponSignalReporter.upsert).not.toHaveBeenCalled()
        expect(tx.couponSignal.update).not.toHaveBeenCalled()
    })

    it('a coupon carrying a failure quorum records the success as a weighted reporter and recomputes', async () => {
        const tx = txWith(4)
        await recordWorked(
            '42',
            { kind: 'user', userId: 'user-1', established: true },
            tx as never,
        )

        expect(tx.couponSignalReporter.upsert).toHaveBeenCalledTimes(1)
        const arg = tx.couponSignalReporter.upsert.mock.calls[0]![0]
        expect(arg.create).toMatchObject({ outcome: 'worked', weight: 2 })
        expect(tx.couponSignal.update).toHaveBeenCalledTimes(1)
    })
})

describe('recordUsage (owns workCount ONLY — W4-D2, replaces coupons.times_used)', () => {
    it('inserts work_count 1 / bumps it by one on conflict, in ONE statement, with NO worked-at stamp', async () => {
        expect(await recordUsage('42')).toBe(true)

        expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
        const query = prismaMock.$queryRaw.mock.calls[0]![0]
        expect(query.values).toEqual(['42', '42'])
        expect(query.sql).toContain(
            'work_count = coupon_signals.work_count + 1',
        )
        // A use is not a trust "worked-at" stamp — recordWorked owns that.
        expect(query.sql).not.toContain('last_worked_at')
    })

    it('an id that is not a catalog row resolves false (the statement returned no row)', async () => {
        prismaMock.$queryRaw.mockResolvedValueOnce([])

        expect(await recordUsage('999')).toBe(false)
        expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    })
})
