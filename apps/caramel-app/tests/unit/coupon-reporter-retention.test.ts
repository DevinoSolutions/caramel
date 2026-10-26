import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hourly timer that keeps the privacy policy's "deleted after 30 days"
// true when nobody reports (couponReporterRetention.ts). Same shape as
// email-delivery-health-monitor.test.ts: module state (the timer) is
// re-imported through vi.resetModules(). The sweep and Sentry are ANNOUNCED
// FAKES (sweepMock / checkInMock): they prove the timer's wiring and the
// check-in statuses, never the sweep itself (coupon-failure-quorum.test.ts).

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

const HOUR = 60 * 60 * 1000

async function loadModule() {
    vi.resetModules()
    return import('@/lib/couponReporterRetention')
}

beforeEach(() => {
    sweepMock.mockClear()
    checkInMock.mockReset()
    checkInMock.mockImplementation(() => 'check-in-id')
    captureExceptionMock.mockClear()
    getClientMock.mockReset()
    getClientMock.mockImplementation(() => ({}))
    vi.useFakeTimers()
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
        expect(sweepMock).not.toHaveBeenCalled()
        expect(checkInMock).not.toHaveBeenCalled()
    })

    it('in production runs a FORCED timer-triggered sweep every hour, never at boot', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        expect(startCouponReporterRetentionSweep().enabled).toBe(true)
        expect(sweepMock).not.toHaveBeenCalled()

        vi.advanceTimersByTime(HOUR)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(sweepMock).toHaveBeenLastCalledWith({
            force: true,
            trigger: 'timer',
        })
        vi.advanceTimersByTime(2 * HOUR)
        expect(sweepMock).toHaveBeenCalledTimes(3)
    })

    it('is idempotent: a second start does not add a second timer', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        startCouponReporterRetentionSweep()
        startCouponReporterRetentionSweep()
        vi.advanceTimersByTime(HOUR)

        expect(sweepMock).toHaveBeenCalledTimes(1)
    })
})

describe('the hourly timer checks in to the Sentry cron monitor', () => {
    async function tickOnce() {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()
        startCouponReporterRetentionSweep()
        await vi.advanceTimersByTimeAsync(HOUR)
    }
    const statuses = () => checkInMock.mock.calls.map(call => call[0].status)

    it('sends in_progress then ok on success, with the interval monitor config', async () => {
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

    it('carries the monitor config (thresholds included) on the closing check-in too', async () => {
        await tickOnce()

        for (const call of checkInMock.mock.calls) {
            expect(call[1]).toMatchObject({
                schedule: { type: 'interval', value: 1, unit: 'hour' },
                checkinMargin: 30,
                maxRuntime: 3,
                failureIssueThreshold: 2,
                recoveryThreshold: 1,
            })
        }
    })

    it('without a Sentry client: boot reason says DISABLED, each tick logs it, the sweep still runs and no check-in is sent', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        getClientMock.mockImplementation(() => undefined)
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        expect(startCouponReporterRetentionSweep().reason).toContain(
            'DISABLED (no Sentry client)',
        )
        await vi.advanceTimersByTimeAsync(HOUR)

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
