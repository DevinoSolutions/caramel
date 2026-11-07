import {
    msUntilNextWallClockSlot,
    wallClockCrontab,
} from '@/lib/wallClockSchedule'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hourly timer that keeps the privacy policy's "deleted after 30 days"
// true when nobody reports (couponReporterRetention.ts). Same shape as
// email-delivery-health-monitor.test.ts: module state (the timer) is
// re-imported through vi.resetModules(). The sweep and Sentry are ANNOUNCED
// FAKES (sweepMock / checkInMock): they prove the timer's wiring and the
// check-in statuses, never the sweep itself (coupon-failure-quorum.test.ts).
// The tick is pinned to the WALL CLOCK (:07 UTC), so every test fixes the
// system time (vi.setSystemTime) before starting the module (T-9433 /
// CARAMEL-39: a boot-relative interval never fired when deploys were under an
// hour apart).

type SweepRun =
    | {
          outcome: 'ok' | 'backlog' | 'failed' | 'timeout'
          deleted: number
          chunks: number
          durationMs: number
      }
    | { outcome: 'skipped'; reason: 'throttled' | 'abandoned' }

const { sweepMock, checkInMock, captureExceptionMock, getClientMock } =
    vi.hoisted(() => ({
        sweepMock: vi.fn(
            async (_options?: {
                force?: boolean
                trigger?: string
            }): Promise<SweepRun> => ({
                outcome: 'ok',
                deleted: 0,
                chunks: 1,
                durationMs: 3,
            }),
        ),
        checkInMock: vi.fn(
            (_checkIn: Record<string, unknown>, _config?: unknown): string =>
                'check-in-id',
        ),
        captureExceptionMock: vi.fn(),
        getClientMock: vi.fn((): object | undefined => ({})),
    }))
vi.mock('@/lib/couponSignals', () => ({ sweepExpiredReporters: sweepMock }))
vi.mock('@sentry/nextjs', () => ({
    captureCheckIn: checkInMock,
    captureException: captureExceptionMock,
    getClient: getClientMock,
}))
vi.mock('server-only', () => ({}))

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
// Wall-clock fixtures (UTC). The slot is minute 7 of every hour.
const BOOT_AT_10_50 = '2026-10-27T10:50:00.000Z'
const SLOT_11_07_MS = Date.parse('2026-10-27T11:07:00.000Z')
/** Time from the 10:50 boot to the 11:07 slot. */
const BOOT_TO_SLOT_MS = 17 * MINUTE

async function loadModule() {
    vi.resetModules()
    return import('@/lib/couponReporterRetention')
}

beforeEach(() => {
    sweepMock.mockReset()
    sweepMock.mockImplementation(async () => ({
        outcome: 'ok',
        deleted: 0,
        chunks: 1,
        durationMs: 3,
    }))
    checkInMock.mockReset()
    checkInMock.mockImplementation(() => 'check-in-id')
    captureExceptionMock.mockClear()
    getClientMock.mockReset()
    getClientMock.mockImplementation(() => ({}))
    vi.useFakeTimers()
    vi.setSystemTime(new Date(BOOT_AT_10_50))
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
})

describe('startCouponReporterRetentionSweep', () => {
    it('is off outside production: no timer, and it says why', async () => {
        vi.stubEnv('NODE_ENV', 'test')
        const { startCouponReporterRetentionSweep } = await loadModule()

        const decision = startCouponReporterRetentionSweep()
        vi.advanceTimersByTime(3 * HOUR)

        expect(decision.enabled).toBe(false)
        expect(decision.reason).not.toBe('')
        expect(vi.getTimerCount()).toBe(0)
        expect(sweepMock).not.toHaveBeenCalled()
        expect(checkInMock).not.toHaveBeenCalled()
    })

    it('in production runs a FORCED timer-triggered sweep at :07 of the next hour, never at boot and not 60 minutes after boot', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        const decision = startCouponReporterRetentionSweep()
        expect(decision.enabled).toBe(true)
        expect(decision.reason).toContain('2026-10-27T11:07:00.000Z')
        expect(sweepMock).not.toHaveBeenCalled()

        // 16 minutes after a :50 boot it is :06: not yet.
        vi.advanceTimersByTime(BOOT_TO_SLOT_MS - MINUTE)
        expect(sweepMock).not.toHaveBeenCalled()
        // :07 is 17 minutes after boot, not 60.
        vi.advanceTimersByTime(MINUTE)
        expect(Date.now()).toBe(SLOT_11_07_MS)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(sweepMock).toHaveBeenLastCalledWith({
            force: true,
            trigger: 'timer',
        })
    })

    it('a boot at :06 (inside the 2 minute guard before the slot) skips to :07 of the NEXT hour', async () => {
        vi.setSystemTime(new Date('2026-10-27T10:06:00.000Z'))
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        expect(startCouponReporterRetentionSweep().reason).toContain(
            '2026-10-27T11:07:00.000Z',
        )
        // 10:07 passes without a sweep: it is inside the guard window.
        vi.advanceTimersByTime(MINUTE)
        expect(Date.now()).toBe(Date.parse('2026-10-27T10:07:00.000Z'))
        expect(sweepMock).not.toHaveBeenCalled()
        // 11:07 sweeps.
        vi.advanceTimersByTime(HOUR)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(Date.now()).toBe(SLOT_11_07_MS)
    })

    it('a boot at :05 (exactly the guard away) still takes the :07 slot of the same hour', async () => {
        vi.setSystemTime(new Date('2026-10-27T10:05:00.000Z'))
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        startCouponReporterRetentionSweep()
        vi.advanceTimersByTime(2 * MINUTE)

        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(Date.now()).toBe(Date.parse('2026-10-27T10:07:00.000Z'))
    })

    it('consecutive ticks are exactly one hour apart on the wall clock', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()
        const tickTimes: number[] = []
        sweepMock.mockImplementation(async () => {
            tickTimes.push(Date.now())
            return { outcome: 'ok', deleted: 0, chunks: 1, durationMs: 1 }
        })

        startCouponReporterRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS + 3 * HOUR)

        expect(tickTimes).toEqual([
            SLOT_11_07_MS,
            SLOT_11_07_MS + HOUR,
            SLOT_11_07_MS + 2 * HOUR,
            SLOT_11_07_MS + 3 * HOUR,
        ])
    })

    it('keeps ticking after a tick whose sweep never settles (the schedule is re-armed BEFORE the sweep is awaited)', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()
        // A hung DELETE: the first tick's sweep never resolves or rejects.
        sweepMock.mockImplementationOnce(() => new Promise<SweepRun>(() => {}))

        startCouponReporterRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(HOUR)

        expect(sweepMock).toHaveBeenCalledTimes(2)
    })

    it('is idempotent: a second start is a no-op and does not add a second timer', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        startCouponReporterRetentionSweep()
        expect(startCouponReporterRetentionSweep().reason).toBe(
            'already started',
        )
        expect(vi.getTimerCount()).toBe(1)
        vi.advanceTimersByTime(BOOT_TO_SLOT_MS)

        expect(sweepMock).toHaveBeenCalledTimes(1)
    })
})

describe('the hourly timer checks in to the Sentry cron monitor', () => {
    async function tickOnce() {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()
        startCouponReporterRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
    }
    const statuses = () => checkInMock.mock.calls.map(call => call[0].status)

    it('sends in_progress then ok on success', async () => {
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'ok'])
        expect(checkInMock.mock.calls[1]![0]).toMatchObject({
            monitorSlug: 'caramel-coupon-reporter-retention',
            checkInId: 'check-in-id',
        })
    })

    it.each(['failed', 'timeout'] as const)(
        'checks in as error when the run outcome is %s',
        async outcome => {
            sweepMock.mockResolvedValueOnce({
                outcome,
                deleted: 0,
                chunks: 0,
                durationMs: 1,
            })
            await tickOnce()
            expect(statuses()).toEqual(['in_progress', 'error'])
        },
    )

    it('maps backlog to ok on purpose: a saturated sweep is visible in the logs, not a paging alert', async () => {
        sweepMock.mockResolvedValueOnce({
            outcome: 'backlog',
            deleted: 500000,
            chunks: 100,
            durationMs: 1,
        })
        await tickOnce()
        expect(statuses()).toEqual(['in_progress', 'ok'])
    })

    it('a skipped tick (abandoned DELETE still unsettled) is logged loudly and checks in as error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        sweepMock.mockResolvedValueOnce({
            outcome: 'skipped',
            reason: 'abandoned',
        })
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'error'])
        expect(errorSpy).toHaveBeenCalledWith(
            '[couponReporterRetention] tick skipped: previous DELETE still unsettled',
        )
        errorSpy.mockRestore()
    })

    it('a sweep that throws checks in as error and is captured', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        sweepMock.mockRejectedValueOnce(new Error('boom'))
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'error'])
        expect(captureExceptionMock).toHaveBeenCalled()
        errorSpy.mockRestore()
    })

    it('carries the :07 crontab monitor config (thresholds included) on every check-in, closing one too', async () => {
        await tickOnce()

        expect(checkInMock).toHaveBeenCalledTimes(2)
        for (const call of checkInMock.mock.calls) {
            expect(call[1]).toEqual({
                schedule: { type: 'crontab', value: '7 * * * *' },
                timezone: 'UTC',
                checkinMargin: 30,
                maxRuntime: 3,
                failureIssueThreshold: 2,
                recoveryThreshold: 1,
            })
        }
    })

    it('the monitor crontab is built from the timer schedule and names the minute the timer fires at', async () => {
        const mod = await loadModule()

        expect(mod.REPORTER_RETENTION_MONITOR_CONFIG.schedule.value).toBe(
            wallClockCrontab(mod.REPORTER_RETENTION_SCHEDULE),
        )
        expect(mod.REPORTER_RETENTION_MONITOR_CONFIG.schedule.value).toBe(
            '7 * * * *',
        )
        // The timer's first slot from a :50 boot is :07.
        expect(
            Date.now() +
                msUntilNextWallClockSlot(
                    mod.REPORTER_RETENTION_SCHEDULE,
                    Date.now(),
                ),
        ).toBe(SLOT_11_07_MS)
    })

    it('without a Sentry client: boot reason says DISABLED, each tick logs it, the sweep still runs and no check-in is sent', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        getClientMock.mockImplementation(() => undefined)
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        expect(startCouponReporterRetentionSweep().reason).toContain(
            'DISABLED (no Sentry client)',
        )
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)

        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(checkInMock).not.toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('cron check-ins DISABLED'),
        )
        errorSpy.mockRestore()
    })

    it('a check-in that throws is captured and logged loudly, and the sweep still runs', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        checkInMock.mockImplementation(() => {
            throw new Error('sentry down')
        })
        await tickOnce()

        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(captureExceptionMock).toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalled()
        errorSpy.mockRestore()
    })
})
