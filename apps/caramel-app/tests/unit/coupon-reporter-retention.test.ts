import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hourly timer that keeps the privacy policy's "deleted after 30 days"
// true when nobody reports (couponReporterRetention.ts). Same shape as
// email-delivery-health-monitor.test.ts: module state (the timer) is
// re-imported through vi.resetModules(). The sweep and Sentry are ANNOUNCED
// FAKES (sweepMock / checkInMock): they prove the timer's wiring and the
// check-in statuses, never the sweep itself (coupon-failure-quorum.test.ts).

type SweepRun = {
    outcome: 'ok' | 'backlog' | 'failed' | 'timeout'
    deleted: number
    chunks: number
    durationMs: number
} | null

const { sweepMock, checkInMock, captureExceptionMock } = vi.hoisted(() => ({
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
}))
vi.mock('@/lib/couponSignals', () => ({ sweepExpiredReporters: sweepMock }))
vi.mock('@sentry/nextjs', () => ({
    captureCheckIn: checkInMock,
    captureException: captureExceptionMock,
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
        expect(checkInMock.mock.calls[0]![1]).toMatchObject({
            schedule: { type: 'interval', value: 1, unit: 'hour' },
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

    it('checks in as error when no run started (an abandoned DELETE is still unsettled)', async () => {
        sweepMock.mockResolvedValueOnce(null)
        await tickOnce()
        expect(statuses()).toEqual(['in_progress', 'error'])
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
