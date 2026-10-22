import type { ReportReporter } from '@/lib/couponReportDedupe'
import { attachSignals, recordUsage, recordWorked } from '@/lib/couponSignals'
import * as Sentry from '@sentry/nextjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// couponSignals unit pins. Mocks @/lib/prisma (the app Postgres the signal
// table lives in) so each writer/merger is tested in isolation:
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
                upsert: vi.fn(
                    async (args: {
                        where: { couponId: string }
                        create: Record<string, unknown>
                        update: Record<string, unknown>
                    }) => ({ couponId: args.where.couponId }),
                ),
            },
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
    prismaMock.couponSignal.upsert.mockClear()
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

    /** A transaction client whose coupon_signals row carries `failWeight`. */
    function txWith(failWeight: number) {
        return {
            couponSignal: {
                upsert: vi.fn(
                    async (_args: {
                        where: { couponId: string }
                        create: Record<string, unknown>
                        update: Record<string, unknown>
                        select: Record<string, unknown>
                    }) => ({ failWeight }),
                ),
                update: vi.fn(async () => ({})),
            },
            couponSignalReporter: {
                findMany: vi.fn(async () => []),
                upsert: vi.fn(
                    async (_args: {
                        create: { outcome: string; weight: number }
                    }) => ({}),
                ),
            },
        }
    }

    it('upserts lastWorkedAt on both create and update, and NEVER touches workCount', async () => {
        const tx = txWith(0)
        await recordWorked('42', anon, tx as never)

        expect(tx.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = tx.couponSignal.upsert.mock.calls[0]![0]
        expect(arg.where).toEqual({ couponId: '42' })
        expect(arg.create).toMatchObject({ couponId: '42' })
        expect(arg.create.lastWorkedAt).toBeInstanceOf(Date)
        expect(arg.create).not.toHaveProperty('workCount')
        expect(arg.update.lastWorkedAt).toBeInstanceOf(Date)
        // The whole point of the split: a "worked" report must not bump the
        // counter, or a successful apply (report + increment) double-counts.
        expect(arg.update).not.toHaveProperty('workCount')
    })

    it('a coupon with no failure quorum stores nothing about the reporter', async () => {
        const tx = txWith(0)
        await recordWorked('42', anon, tx as never)

        expect(tx.couponSignalReporter.upsert).not.toHaveBeenCalled()
        expect(tx.couponSignal.update).not.toHaveBeenCalled()
    })

    it('a coupon carrying a failure quorum records the success as a weighted reporter and recomputes', async () => {
        const tx = txWith(4)
        await recordWorked(
            '42',
            { kind: 'user', userId: 'user-1' },
            tx as never,
        )

        expect(tx.couponSignalReporter.upsert).toHaveBeenCalledTimes(1)
        const arg = tx.couponSignalReporter.upsert.mock.calls[0]![0]
        expect(arg.create).toMatchObject({ outcome: 'worked', weight: 2 })
        expect(tx.couponSignal.update).toHaveBeenCalledTimes(1)
    })
})

describe('recordUsage (owns workCount ONLY — W4-D2, replaces coupons.times_used)', () => {
    it('upserts create:{workCount:1} / update:{workCount:{increment:1}} with NO timestamp', async () => {
        await recordUsage('42')

        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = prismaMock.couponSignal.upsert.mock.calls[0]![0]
        expect(arg.where).toEqual({ couponId: '42' })
        expect(arg.create).toEqual({ couponId: '42', workCount: 1 })
        expect(arg.update).toEqual({ workCount: { increment: 1 } })
        // A use is not a trust "worked-at" stamp — recordWorked owns that.
        expect(arg.create).not.toHaveProperty('lastWorkedAt')
        expect(arg.update).not.toHaveProperty('lastWorkedAt')
    })
})
