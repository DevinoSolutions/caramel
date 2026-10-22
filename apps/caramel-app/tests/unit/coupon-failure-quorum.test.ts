import { readEdgeClientIp } from '@/lib/clientIp'
import {
    NO_EDGE_REPORTER_NETWORK,
    reporterFor,
    type ReportReporter,
} from '@/lib/couponReportDedupe'
import {
    FAILING_MIN_FAIL_WEIGHT,
    FAILING_WINDOW_MS,
    isRecentlyFailing,
    keepsFailing,
} from '@/lib/coupons'
import {
    CLEARING_WORKED_WEIGHT,
    recordFailed,
    recordWorked,
    reporterHash,
    reporterWeight,
    resetReporterSweepForTests,
    sweepExpiredReporters,
} from '@/lib/couponSignals'
import * as Sentry from '@sentry/nextjs'
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-5535 M3: a code is sunk / collapsed by a QUORUM of distinct weighted
// reporters, not by raw report counts, so three forged anonymous reports (the
// old sink threshold was two) cannot flag a code.
//
// ANNOUNCED FAKE, not a canned mock: `fakeDb` below is a tiny in-memory
// stand-in for the two tables recordFailed writes (coupon_signals and
// coupon_signal_reporters) that implements the upsert / aggregate / update /
// deleteMany semantics couponSignals.ts relies on, so the quorum arithmetic is
// EXERCISED rather than asserted against canned answers. A fake proves the
// logic and never the SQL; tests/integration/coupon-report.itest.ts runs the
// same scenarios against real Postgres.
// The global retention sweep (sweepExpiredReporters) uses the singleton client:
// tests point `sweepClient.deleteMany` at the fake table.
const { sweepClient } = vi.hoisted(() => ({
    sweepClient: {
        deleteMany: vi.fn(
            async (_args: unknown): Promise<{ count: number }> => ({
                count: 0,
            }),
        ),
    },
}))
vi.mock('@/lib/prisma', () => ({
    default: { couponSignalReporter: sweepClient },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

type SignalRow = {
    couponId: string
    failCount: number
    failWeight: number
    lastFailedAt: Date | null
    lastWorkedAt: Date | null
    lastFailReason: string | null
}
type ReporterRow = {
    couponId: string
    outcome: string
    reporterHash: string
    weight: number
    lastAt: Date
}

function makeFakeDb() {
    const signals = new Map<string, SignalRow>()
    const reporters = new Map<string, ReporterRow>()
    const keyOf = (w: {
        couponId: string
        outcome: string
        reporterHash: string
    }) => `${w.couponId}|${w.outcome}|${w.reporterHash}`
    const tx = {
        couponSignalReporter: {
            upsert: vi.fn(
                async (args: {
                    where: {
                        couponId_outcome_reporterHash: {
                            couponId: string
                            outcome: string
                            reporterHash: string
                        }
                    }
                    create: ReporterRow
                    update: { weight: number; lastAt: Date }
                }) => {
                    const key = keyOf(args.where.couponId_outcome_reporterHash)
                    const existing = reporters.get(key)
                    const row = existing
                        ? { ...existing, ...args.update }
                        : { ...args.create }
                    reporters.set(key, row)
                    return row
                },
            ),
            findMany: vi.fn(
                async (args: {
                    where: { couponId: string; lastAt: { gt: Date } }
                }) =>
                    Array.from(reporters.values()).filter(
                        r =>
                            r.couponId === args.where.couponId &&
                            r.lastAt > args.where.lastAt.gt,
                    ),
            ),
            aggregate: vi.fn(
                async (args: {
                    where: {
                        couponId: string
                        outcome: string
                        lastAt: { gt: Date }
                    }
                }) => {
                    const matching = Array.from(reporters.values()).filter(
                        r =>
                            r.couponId === args.where.couponId &&
                            r.outcome === args.where.outcome &&
                            r.lastAt > args.where.lastAt.gt,
                    )
                    return {
                        _sum: {
                            weight: matching.length
                                ? matching.reduce((n, r) => n + r.weight, 0)
                                : null,
                        },
                    }
                },
            ),
            deleteMany: vi.fn(
                async (args: {
                    where: {
                        couponId?: string
                        outcome?: string
                        lastAt: { lt: Date }
                    }
                }) => {
                    let count = 0
                    reporters.forEach((r, key) => {
                        if (
                            (args.where.couponId === undefined ||
                                r.couponId === args.where.couponId) &&
                            (args.where.outcome === undefined ||
                                r.outcome === args.where.outcome) &&
                            r.lastAt < args.where.lastAt.lt
                        ) {
                            reporters.delete(key)
                            count++
                        }
                    })
                    return { count }
                },
            ),
        },
        couponSignal: {
            upsert: vi.fn(
                async (args: {
                    where: { couponId: string }
                    create: Partial<SignalRow>
                    update: Record<string, unknown>
                }) => {
                    const existing = signals.get(args.where.couponId)
                    const row: SignalRow = existing
                        ? { ...existing }
                        : {
                              couponId: args.where.couponId,
                              failCount: 0,
                              failWeight: 0,
                              lastFailedAt: null,
                              lastWorkedAt: null,
                              lastFailReason: null,
                              ...args.create,
                          }
                    if (existing) {
                        for (const [field, value] of Object.entries(
                            args.update,
                        )) {
                            if (
                                value &&
                                typeof value === 'object' &&
                                'increment' in value
                            ) {
                                ;(row as Record<string, unknown>)[field] =
                                    (row as unknown as Record<string, number>)[
                                        field
                                    ]! +
                                    Number(
                                        (value as { increment: number })
                                            .increment,
                                    )
                            } else {
                                ;(row as Record<string, unknown>)[field] = value
                            }
                        }
                    }
                    signals.set(row.couponId, row)
                    return row
                },
            ),
            update: vi.fn(
                async (args: {
                    where: { couponId: string }
                    data: { failWeight: number }
                }) => {
                    const row = signals.get(args.where.couponId)
                    if (!row) throw new Error('update of a missing signal row')
                    row.failWeight = args.data.failWeight
                    return row
                },
            ),
        },
    }
    // The singleton client's deleteMany reaches the same table.
    sweepClient.deleteMany.mockImplementation(async args =>
        tx.couponSignalReporter.deleteMany(args as never),
    )
    return { signals, reporters, tx }
}

const anon = (n: number): ReportReporter => ({
    kind: 'ip',
    ip: `203.0.113.${n}`,
})
const account = (id: string): ReportReporter => ({ kind: 'user', userId: id })
const COUPON = '42'

let db: ReturnType<typeof makeFakeDb>

/** The overlay shape the card and SQL read, from the stored row. */
function stored() {
    const row = db.signals.get(COUPON)
    return {
        failWeight: row?.failWeight ?? 0,
        lastFailedAt: row?.lastFailedAt ?? null,
        lastWorkedAt: row?.lastWorkedAt ?? null,
    }
}

const fail = (reporter: ReportReporter) =>
    recordFailed(COUPON, null, reporter, db.tx as never)

beforeEach(() => {
    resetReporterSweepForTests()
    db = makeFakeDb()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('failure quorum: forged anonymous reports cannot sink a code', () => {
    it('three distinct anonymous reporters do NOT sink it; the fourth does', async () => {
        for (let n = 1; n <= 3; n++) await fail(anon(n))
        expect(stored().failWeight).toBe(3)
        expect(isRecentlyFailing(stored())).toBe(false)

        await fail(anon(4))
        expect(stored().failWeight).toBe(FAILING_MIN_FAIL_WEIGHT)
        expect(isRecentlyFailing(stored())).toBe(true)
        // Sinking is not collapsing: that needs a stronger quorum.
        expect(keepsFailing(stored())).toBe(false)
    })

    it('six anonymous reporters collapse it', async () => {
        for (let n = 1; n <= 6; n++) await fail(anon(n))
        expect(keepsFailing(stored())).toBe(true)
    })

    it('signed-in accounts count double: two accounts sink it, one account plus two networks sink it, one account alone does not', async () => {
        await fail(account('user-1'))
        expect(isRecentlyFailing(stored())).toBe(false)
        await fail(account('user-2'))
        expect(isRecentlyFailing(stored())).toBe(true)

        db = makeFakeDb()
        await fail(account('user-1'))
        await fail(anon(1))
        expect(isRecentlyFailing(stored())).toBe(false)
        await fail(anon(2))
        expect(isRecentlyFailing(stored())).toBe(true)
    })

    it('the raw count keeps rising but decides nothing: one reporter re-reporting is still one reporter', async () => {
        await fail(anon(1))
        // The 24h in-memory dedupe lets the same reporter back in after a day
        // (or a restart); the quorum must still see ONE reporter.
        vi.setSystemTime(new Date('2026-10-22T13:00:00.000Z'))
        await fail(anon(1))
        await fail(anon(1))
        expect(db.signals.get(COUPON)?.failCount).toBe(3)
        expect(stored().failWeight).toBe(1)
        expect(isRecentlyFailing({ ...stored(), failWeight: 1 })).toBe(false)
    })

    const succeed = (reporter: ReportReporter) =>
        recordWorked(COUPON, reporter, db.tx as never)
    const minutesLater = (n: number) =>
        vi.setSystemTime(Date.now() + n * 60_000)

    it('ONE anonymous "worked" does NOT un-sink a code (it would let one forged success undo any number of honest failures)', async () => {
        for (let n = 1; n <= 4; n++) await fail(anon(n))
        expect(isRecentlyFailing(stored())).toBe(true)

        minutesLater(5)
        await succeed(anon(50))
        expect(stored().failWeight).toBe(4)
        expect(isRecentlyFailing(stored())).toBe(true)
        // The success is still recorded as the last-worked stamp ("Verified").
        expect(stored().lastWorkedAt).toBeInstanceOf(Date)
    })

    it('two distinct anonymous "worked" reporters clear it; so does ONE signed-in "worked"', async () => {
        expect(CLEARING_WORKED_WEIGHT).toBe(2)
        for (let n = 1; n <= 4; n++) await fail(anon(n))

        minutesLater(5)
        await succeed(anon(50))
        expect(isRecentlyFailing(stored())).toBe(true)
        await succeed(anon(51))
        expect(stored().failWeight).toBe(0)
        expect(isRecentlyFailing(stored())).toBe(false)

        db = makeFakeDb()
        for (let n = 1; n <= 4; n++) await fail(anon(n))
        minutesLater(5)
        await succeed(account('user-9'))
        expect(stored().failWeight).toBe(0)
    })

    it('one reporter re-reporting "worked" is still one reporter', async () => {
        for (let n = 1; n <= 4; n++) await fail(anon(n))
        minutesLater(5)
        await succeed(anon(50))
        minutesLater(1)
        await succeed(anon(50))
        expect(stored().failWeight).toBe(4)
    })

    it('a success only clears the failures BEFORE it: failures after the cleared quorum count afresh', async () => {
        for (let n = 1; n <= 4; n++) await fail(anon(n))
        minutesLater(5)
        await succeed(account('user-9'))
        expect(stored().failWeight).toBe(0)

        minutesLater(5)
        await fail(anon(10))
        await fail(anon(11))
        // Two NEW reporters after the success: weight 2, not 2 + the old 4.
        expect(stored().failWeight).toBe(2)
        expect(isRecentlyFailing(stored())).toBe(false)
    })

    it('a "worked" on a coupon with no failure quorum stores nothing about the reporter (no new personal data)', async () => {
        await succeed(anon(50))
        expect(db.reporters.size).toBe(0)
        expect(stored().lastWorkedAt).toBeInstanceOf(Date)
    })

    it('a grandfathered legacy failure row resets exactly like any other', async () => {
        const now = new Date()
        db.signals.set(COUPON, {
            couponId: COUPON,
            failCount: 3,
            failWeight: 6,
            lastFailedAt: now,
            lastWorkedAt: null,
            lastFailReason: null,
        })
        db.reporters.set('legacy', {
            couponId: COUPON,
            outcome: 'failed',
            reporterHash: 'legacy',
            weight: 6,
            lastAt: now,
        })
        minutesLater(5)
        await succeed(anon(50))
        expect(stored().failWeight).toBe(6)
        await succeed(anon(51))
        expect(stored().failWeight).toBe(0)
    })

    it('a reporter whose failure is older than the window stops counting, and its row is pruned', async () => {
        for (let n = 1; n <= 3; n++) await fail(anon(n))
        const later = Date.now() + FAILING_WINDOW_MS + 60_000
        vi.setSystemTime(new Date(later))
        await fail(anon(9))

        expect(stored().failWeight).toBe(1)
        expect(db.reporters.size).toBe(1)
    })

    it('retention: the global sweep removes an expired reporter of a coupon nobody reports again, at most hourly, and only after it SUCCEEDED does it wait', async () => {
        await recordFailed('77', null, anon(1), db.tx as never)
        expect(db.reporters.size).toBe(1)
        // recordFailed itself no longer sweeps globally (that is outside its
        // transaction), only its own coupon.
        vi.setSystemTime(Date.now() + FAILING_WINDOW_MS + 60_000)
        await recordFailed(COUPON, null, anon(2), db.tx as never)
        expect(db.reporters.size).toBe(2)

        await sweepExpiredReporters()
        expect(
            Array.from(db.reporters.values()).map(row => row.couponId),
        ).toEqual([COUPON])

        // Throttled: an expired row planted right after waits for the hour.
        db.reporters.set('stale', {
            couponId: '88',
            outcome: 'failed',
            reporterHash: reporterHash(anon(3)),
            weight: 1,
            lastAt: new Date(Date.now() - FAILING_WINDOW_MS - 1000),
        })
        await sweepExpiredReporters()
        expect(db.reporters.has('stale')).toBe(true)
        vi.setSystemTime(Date.now() + 61 * 60 * 1000)
        await sweepExpiredReporters()
        expect(db.reporters.has('stale')).toBe(false)
    })

    it('a failing sweep is reported loudly (Sentry + console) and backs off 5 minutes: a call inside the window starts no DELETE, one after it retries', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(Sentry.captureException).mockClear()
        sweepClient.deleteMany.mockClear()
        sweepClient.deleteMany.mockRejectedValueOnce(new Error('db down'))

        await sweepExpiredReporters()
        expect(Sentry.captureException).toHaveBeenCalledTimes(1)
        expect(errorSpy).toHaveBeenCalled()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)

        db.reporters.set('stale', {
            couponId: '88',
            outcome: 'failed',
            reporterHash: reporterHash(anon(3)),
            weight: 1,
            lastAt: new Date(Date.now() - FAILING_WINDOW_MS - 1000),
        })
        vi.setSystemTime(Date.now() + 4 * 60 * 1000)
        await sweepExpiredReporters()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
        expect(db.reporters.has('stale')).toBe(true)

        vi.setSystemTime(Date.now() + 61 * 1000)
        await sweepExpiredReporters()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
        expect(db.reporters.has('stale')).toBe(false)
        errorSpy.mockRestore()
    })

    it('force:true right after a failure still starts a DELETE (the timer skips the backoff)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        sweepClient.deleteMany.mockClear()
        sweepClient.deleteMany.mockRejectedValueOnce(new Error('db down'))

        await sweepExpiredReporters()
        await sweepExpiredReporters()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
        await sweepExpiredReporters({ force: true })
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
        errorSpy.mockRestore()
    })

    it('a DELETE that throws synchronously is reported and backed off, never rejected', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(Sentry.captureException).mockClear()
        sweepClient.deleteMany.mockClear()
        sweepClient.deleteMany.mockImplementationOnce(() => {
            throw new Error('client not ready')
        })

        await expect(sweepExpiredReporters()).resolves.toBeUndefined()
        expect(Sentry.captureException).toHaveBeenCalledTimes(1)
        await sweepExpiredReporters()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
        errorSpy.mockRestore()
    })

    describe('a DELETE that hangs', () => {
        let errorSpy: ReturnType<typeof vi.spyOn>
        let settleHung: (value: { count: number }) => void
        let rejectHung: (reason: Error) => void

        /** Start a sweep whose DELETE never answers until settleHung/rejectHung. */
        async function startHungSweepAndTimeOut() {
            sweepClient.deleteMany.mockClear()
            vi.mocked(Sentry.captureException).mockClear()
            sweepClient.deleteMany.mockImplementationOnce(
                () =>
                    new Promise<{ count: number }>((resolve, reject) => {
                        settleHung = resolve
                        rejectHung = reject
                    }),
            )
            const hung = sweepExpiredReporters()
            const shared = sweepExpiredReporters()
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(59_000)
            expect(Sentry.captureException).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(2_000)
            await Promise.all([hung, shared])
        }

        beforeEach(() => {
            vi.useFakeTimers({
                toFake: ['Date', 'setTimeout', 'clearTimeout'],
            })
            vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
            errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        })

        afterEach(() => {
            errorSpy.mockRestore()
        })

        it('is reported after 60 s (Sentry tagged timeout) and frees the in-flight slot', async () => {
            await startHungSweepAndTimeOut()

            expect(Sentry.captureException).toHaveBeenCalledTimes(1)
            expect(
                vi.mocked(Sentry.captureException).mock.calls[0]![1],
            ).toMatchObject({
                tags: {
                    area: 'couponSignals.sweepExpiredReporters',
                    timeout: 'true',
                },
            })
        })

        it('while the abandoned DELETE is still pending neither a report call nor a force call starts another; once it settles the next call does', async () => {
            await startHungSweepAndTimeOut()

            // Past the 5-minute backoff, repeatedly: still only the one DELETE.
            await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
            await sweepExpiredReporters()
            await sweepExpiredReporters({ force: true })
            await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
            await sweepExpiredReporters()
            await sweepExpiredReporters({ force: true })
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)

            settleHung({ count: 0 })
            await vi.advanceTimersByTimeAsync(0)
            await sweepExpiredReporters()
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
        })

        it('the backoff still applies after the abandoned DELETE settles early', async () => {
            await startHungSweepAndTimeOut()
            settleHung({ count: 0 })
            await vi.advanceTimersByTimeAsync(0)

            await sweepExpiredReporters()
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
            await sweepExpiredReporters()
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
        })

        it('an abandoned DELETE that rejects later is reported as a second, late exception and frees the slot', async () => {
            await startHungSweepAndTimeOut()
            expect(Sentry.captureException).toHaveBeenCalledTimes(1)

            rejectHung(new Error('connection reset'))
            await vi.advanceTimersByTimeAsync(0)

            expect(Sentry.captureException).toHaveBeenCalledTimes(2)
            expect(
                vi.mocked(Sentry.captureException).mock.calls[1]![1],
            ).toMatchObject({
                tags: {
                    area: 'couponSignals.sweepExpiredReporters',
                    late: 'true',
                },
            })
            await sweepExpiredReporters({ force: true })
            expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
        })
    })

    it('concurrent triggers share ONE sweep: a slow or failing DELETE is never stampeded', async () => {
        let release: (value: { count: number }) => void = () => {}
        sweepClient.deleteMany.mockClear()
        sweepClient.deleteMany.mockImplementationOnce(
            () =>
                new Promise<{ count: number }>(resolve => {
                    release = resolve
                }),
        )

        const first = sweepExpiredReporters()
        const second = sweepExpiredReporters()
        const forced = sweepExpiredReporters({ force: true })
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)

        release({ count: 0 })
        await Promise.all([first, second, forced])
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
    })

    it('force skips the hourly throttle (the retention timer uses it)', async () => {
        sweepClient.deleteMany.mockClear()
        await sweepExpiredReporters()
        await sweepExpiredReporters()
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(1)
        await sweepExpiredReporters({ force: true })
        expect(sweepClient.deleteMany).toHaveBeenCalledTimes(2)
    })

    it('runs in one transaction when handed a plain client', async () => {
        const transaction = vi.fn(
            async (fn: (tx: typeof db.tx) => Promise<unknown>) => fn(db.tx),
        )
        await recordFailed(COUPON, 'min spend', anon(1), {
            $transaction: transaction,
        } as never)
        expect(transaction).toHaveBeenCalledTimes(1)
        expect(db.signals.get(COUPON)?.lastFailReason).toBe('min spend')
    })
})

describe('reporter identity as stored', () => {
    it('is a salted hash: no raw IP or user id, stable per reporter, distinct per reporter and per kind', () => {
        const a = reporterHash(anon(1))
        expect(a).toMatch(/^[0-9a-f]{32}$/)
        expect(a).not.toContain('203')
        expect(reporterHash(anon(1))).toBe(a)
        expect(reporterHash(anon(2))).not.toBe(a)
        // A user id and an IP with the same text never collide.
        expect(reporterHash({ kind: 'user', userId: '203.0.113.1' })).not.toBe(
            a,
        )
        expect(reporterHash(account('user-secret-1'))).not.toContain(
            'user-secret-1',
        )
    })

    it('the hash key is derived with a domain separator, never the raw auth secret', () => {
        const secret = 'vitest-fixture-better-auth-secret'
        const rawKeyed = createHmac('sha256', secret)
            .update('i:203.0.113.1')
            .digest('hex')
            .slice(0, 32)
        const derivedKey = createHmac('sha256', secret)
            .update('caramel:coupon-reporter:v1')
            .digest()
        const expected = createHmac('sha256', derivedKey)
            .update('i:203.0.113.1')
            .digest('hex')
            .slice(0, 32)
        expect(reporterHash(anon(1))).toBe(expected)
        expect(reporterHash(anon(1))).not.toBe(rawKeyed)
    })

    it('weights an account above an anonymous network', () => {
        expect(reporterWeight(account('u'))).toBe(2)
        expect(reporterWeight(anon(1))).toBe(1)
    })
})

describe('reporter identity ignores forgeable headers', () => {
    const req = (headers: Record<string, string>) =>
        new NextRequest('http://localhost/api/coupons/42/report', {
            method: 'POST',
            headers,
        })

    it('the edge header names the reporter', () => {
        expect(
            reporterFor(null, req({ 'cf-connecting-ip': '203.0.113.9' })),
        ).toEqual({ kind: 'ip', ip: '203.0.113.9' })
    })

    it('without the edge header, x-forwarded-for and x-real-ip mint NOTHING: every such request is the one shared reporter', () => {
        const forged = [
            reporterFor(null, req({ 'x-forwarded-for': '198.51.100.1' })),
            reporterFor(null, req({ 'x-forwarded-for': '198.51.100.2' })),
            reporterFor(null, req({ 'x-real-ip': '198.51.100.3' })),
            reporterFor(null, req({})),
        ]
        for (const reporter of forged) {
            expect(reporter).toEqual({
                kind: 'ip',
                ip: NO_EDGE_REPORTER_NETWORK,
            })
        }
        expect(new Set(forged.map(reporterHash)).size).toBe(1)
    })

    it('a forged x-forwarded-for beside a real edge header is ignored', () => {
        expect(
            reporterFor(
                null,
                req({
                    'cf-connecting-ip': '203.0.113.9',
                    'x-forwarded-for': '198.51.100.77',
                }),
            ),
        ).toEqual({ kind: 'ip', ip: '203.0.113.9' })
    })

    it('a signed-in reporter is keyed by user whatever the headers say', () => {
        expect(reporterFor('user-1', req({}))).toEqual({
            kind: 'user',
            userId: 'user-1',
        })
    })

    it.each([
        ['203.0.113.9'],
        ['2001:db8::1'],
        ['::1'],
        ['::ffff:203.0.113.9'],
    ])('readEdgeClientIp accepts the IP %s', ip => {
        expect(readEdgeClientIp(new Headers({ 'cf-connecting-ip': ip }))).toBe(
            ip,
        )
    })

    it.each([
        ['not-an-ip'],
        ['203.0.113.9:8080'],
        ['203.0.113.9, 198.51.100.1'],
        ['256.1.1.1'],
        ['1.2.3'],
        ['[2001:db8::1]'],
        ['fe80::1%eth0'],
        ['<script>'],
        ['::1]/x@evil'],
        ['1::2]:80/#'],
        ['[::1'],
        ['::1/128'],
        ['1.2.3.4/24'],
        ['a'.repeat(300)],
    ])(
        'readEdgeClientIp treats the non-IP %s as missing, so it mints no identity',
        bad => {
            const headers = new Headers({ 'cf-connecting-ip': bad })
            expect(readEdgeClientIp(headers)).toBeNull()
            expect(
                reporterFor(
                    null,
                    new NextRequest('http://localhost/x', {
                        headers: { 'cf-connecting-ip': bad },
                    }),
                ),
            ).toEqual({ kind: 'ip', ip: NO_EDGE_REPORTER_NETWORK })
        },
    )

    it('readEdgeClientIp reads only cf-connecting-ip, trimmed, and null when blank or absent', () => {
        expect(
            readEdgeClientIp(
                new Headers({ 'cf-connecting-ip': ' 203.0.113.9 ' }),
            ),
        ).toBe('203.0.113.9')
        expect(
            readEdgeClientIp(new Headers({ 'x-forwarded-for': '1.2.3.4' })),
        ).toBeNull()
        expect(
            readEdgeClientIp(new Headers({ 'cf-connecting-ip': '   ' })),
        ).toBeNull()
    })
})
