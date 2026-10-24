import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hourly timer that keeps the privacy policy's "deleted after 30 days"
// true when nobody reports (couponReporterRetention.ts). Same shape as
// email-delivery-health-monitor.test.ts: module state (the timer) is
// re-imported through vi.resetModules().

const { sweepMock } = vi.hoisted(() => ({
    sweepMock: vi.fn(async (_options?: { force?: boolean }) => {}),
}))
vi.mock('@/lib/couponSignals', () => ({ sweepExpiredReporters: sweepMock }))
vi.mock('server-only', () => ({}))

const HOUR = 60 * 60 * 1000

async function loadModule() {
    vi.resetModules()
    return import('@/lib/couponReporterRetention')
}

beforeEach(() => {
    sweepMock.mockClear()
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
    })

    it('in production runs a FORCED sweep every hour, never at boot', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponReporterRetentionSweep } = await loadModule()

        expect(startCouponReporterRetentionSweep().enabled).toBe(true)
        expect(sweepMock).not.toHaveBeenCalled()

        vi.advanceTimersByTime(HOUR)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(sweepMock).toHaveBeenLastCalledWith({ force: true })
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
