import {
    msUntilNextWallClockSlot,
    wallClockCrontab,
} from '@/lib/wallClockSchedule'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The six-hourly timer for the proposal-row retention sweep
// (couponProposalRetention.ts). Pinned to the WALL CLOCK (00:37, 06:37, 12:37,
// 18:37 UTC) and checking in to a Sentry cron monitor; the slot arithmetic
// itself is tested once in wall-clock-schedule.test.ts. The sweep and Sentry are
// ANNOUNCED FAKES (sweepMock / checkInMock): they prove the timer's wiring and
// the check-in statuses, never the sweep itself (coupon-proposal-retention.test.ts).

type SweepResult = { outcome: 'ok'; deleted: number } | { outcome: 'failed' }

const { sweepMock, checkInMock, captureExceptionMock, getClientMock } =
    vi.hoisted(() => ({
        sweepMock: vi.fn(async (): Promise<SweepResult> => ({
            outcome: 'ok',
            deleted: 0,
        })),
        checkInMock: vi.fn(
            (_checkIn: Record<string, unknown>, _config?: unknown): string =>
                'check-in-id',
        ),
        captureExceptionMock: vi.fn(),
        getClientMock: vi.fn((): object | undefined => ({})),
    }))
vi.mock('@/lib/couponBoxSave', () => ({ sweepExpiredProposals: sweepMock }))
vi.mock('@sentry/nextjs', () => ({
    captureCheckIn: checkInMock,
    captureException: captureExceptionMock,
    getClient: getClientMock,
}))
vi.mock('server-only', () => ({}))

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
// Boot at 10:50 UTC: the next slot is 12:37, 107 minutes away (not 6 hours).
const BOOT_AT_10_50 = '2026-10-27T10:50:00.000Z'
const SLOT_12_37_MS = Date.parse('2026-10-27T12:37:00.000Z')
const BOOT_TO_SLOT_MS = SLOT_12_37_MS - Date.parse(BOOT_AT_10_50)

async function loadModule() {
    vi.resetModules()
    return import('@/lib/couponProposalRetention')
}

beforeEach(() => {
    sweepMock.mockReset()
    sweepMock.mockImplementation(async () => ({ outcome: 'ok', deleted: 0 }))
    checkInMock.mockReset()
    checkInMock.mockImplementation(() => 'check-in-id')
    captureExceptionMock.mockClear()
    getClientMock.mockReset()
    getClientMock.mockImplementation(() => ({}))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date(BOOT_AT_10_50))
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

describe('startCouponProposalRetentionSweep', () => {
    it('is off outside production: no timer, and it says why', async () => {
        vi.stubEnv('NODE_ENV', 'test')
        const { startCouponProposalRetentionSweep } = await loadModule()

        const decision = startCouponProposalRetentionSweep()
        vi.advanceTimersByTime(12 * HOUR)

        expect(decision).toEqual({ enabled: false, reason: 'non-production' })
        expect(vi.getTimerCount()).toBe(0)
        expect(sweepMock).not.toHaveBeenCalled()
        expect(checkInMock).not.toHaveBeenCalled()
    })

    it('in production sweeps at the next 6 hourly slot (12:37), never at boot and not 6 hours after boot', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()

        const decision = startCouponProposalRetentionSweep()
        expect(decision.enabled).toBe(true)
        expect(decision.reason).toContain('2026-10-27T12:37:00.000Z')
        expect(sweepMock).not.toHaveBeenCalled()

        vi.advanceTimersByTime(BOOT_TO_SLOT_MS - 1)
        expect(sweepMock).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(Date.now()).toBe(SLOT_12_37_MS)
        expect(sweepMock).toHaveBeenCalledTimes(1)
    })

    it('ticks every 6 hours on the wall clock', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()
        const times: number[] = []
        sweepMock.mockImplementation(async () => {
            times.push(Date.now())
            return { outcome: 'ok', deleted: 0 }
        })

        startCouponProposalRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS + 12 * HOUR)

        expect(times).toEqual([
            SLOT_12_37_MS,
            SLOT_12_37_MS + 6 * HOUR,
            SLOT_12_37_MS + 12 * HOUR,
        ])
    })

    it('a boot just before a slot (12:36) waits for the next one (18:37)', async () => {
        vi.setSystemTime(new Date('2026-10-27T12:36:00.000Z'))
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()

        expect(startCouponProposalRetentionSweep().reason).toContain(
            '2026-10-27T18:37:00.000Z',
        )
        vi.advanceTimersByTime(2 * MINUTE)
        expect(sweepMock).not.toHaveBeenCalled()
    })

    it('is idempotent: a second start is a no-op and does not add a second timer', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()

        startCouponProposalRetentionSweep()
        expect(startCouponProposalRetentionSweep().reason).toBe(
            'already started',
        )
        expect(vi.getTimerCount()).toBe(1)
        vi.advanceTimersByTime(BOOT_TO_SLOT_MS)

        expect(sweepMock).toHaveBeenCalledTimes(1)
    })

    it('keeps ticking after a tick whose sweep never settles (the schedule is re-armed BEFORE the sweep is awaited)', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()
        sweepMock.mockImplementationOnce(
            () => new Promise<SweepResult>(() => {}),
        )

        startCouponProposalRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
        expect(sweepMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(6 * HOUR)

        expect(sweepMock).toHaveBeenCalledTimes(2)
    })

    it('without a Sentry client: the boot reason says DISABLED, the tick logs it, the sweep still runs and no check-in is sent', async () => {
        getClientMock.mockImplementation(() => undefined)
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()

        expect(startCouponProposalRetentionSweep().reason).toContain(
            'DISABLED (no Sentry client)',
        )
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)

        expect(sweepMock).toHaveBeenCalledTimes(1)
        expect(checkInMock).not.toHaveBeenCalled()
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('cron check-ins DISABLED'),
        )
    })
})

describe('the six-hourly timer checks in to the Sentry cron monitor', () => {
    async function tickOnce() {
        vi.stubEnv('NODE_ENV', 'production')
        const { startCouponProposalRetentionSweep } = await loadModule()
        startCouponProposalRetentionSweep()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
    }
    const statuses = () => checkInMock.mock.calls.map(call => call[0].status)

    it('sends in_progress then ok on success and logs the deleted count', async () => {
        sweepMock.mockResolvedValueOnce({ outcome: 'ok', deleted: 12 })
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'ok'])
        expect(checkInMock.mock.calls[1]![0]).toMatchObject({
            monitorSlug: 'caramel-coupon-proposal-retention',
            checkInId: 'check-in-id',
        })
        expect(console.log).toHaveBeenCalledWith(
            '[couponProposalRetention] swept deleted=12',
        )
    })

    it('a failed sweep checks in as error and is logged loudly (not read as 0 rows deleted)', async () => {
        sweepMock.mockResolvedValueOnce({ outcome: 'failed' })
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'error'])
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[couponProposalRetention] sweep failed'),
        )
    })

    it('a sweep that throws checks in as error and is captured', async () => {
        sweepMock.mockRejectedValueOnce(new Error('boom'))
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'error'])
        expect(captureExceptionMock).toHaveBeenCalled()
    })

    it('carries the 6 hourly crontab monitor config on every check-in, closing one too', async () => {
        await tickOnce()

        expect(checkInMock).toHaveBeenCalledTimes(2)
        for (const call of checkInMock.mock.calls) {
            expect(call[1]).toEqual({
                schedule: { type: 'crontab', value: '37 */6 * * *' },
                timezone: 'UTC',
                checkinMargin: 30,
                maxRuntime: 5,
                failureIssueThreshold: 2,
                recoveryThreshold: 1,
            })
        }
    })

    it('the monitor crontab is built from the timer schedule', async () => {
        const mod = await loadModule()

        expect(mod.PROPOSAL_RETENTION_MONITOR_CONFIG.schedule.value).toBe(
            wallClockCrontab(mod.PROPOSAL_RETENTION_SCHEDULE),
        )
        expect(
            Date.now() +
                msUntilNextWallClockSlot(
                    mod.PROPOSAL_RETENTION_SCHEDULE,
                    Date.now(),
                ),
        ).toBe(SLOT_12_37_MS)
    })
})
