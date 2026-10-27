import type { EmailDeliveryHealthReport } from '@/lib/emailDeliveryHealth'
import { wallClockCrontab } from '@/lib/wallClockSchedule'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The schedule around the delivery check. Caramel owns no cron and no worker,
// so the check rides an unref'd wall-clock timer (wallClockSchedule.ts) on the
// Next server process. That buys four obligations, each pinned below:
//
//   1. the enable decision is a pure table (prod default ON when Sendly is
//      configured, env var overrides BOTH ways) — a deploy must never have to
//      guess whether the check is running;
//   2. at most ONE Sentry event per clock hour, so a degraded provider cannot
//      turn into an issue storm, and 'ok' windows are silent;
//   3. runs sit on the UTC wall clock (:23 for the default hourly period), never
//      at boot and never boot + interval: a boot-relative interval was starved
//      by deploys closer together than the interval (T-9436), and a
//      crash-looping container must still not machine-gun Sentry;
//   4. every run checks in to a Sentry cron monitor whose crontab is built from
//      the same schedule; a run that completes and finds delivery problems is
//      still 'ok' (those are their own Sentry event), a check that could not run
//      is 'error'.
//
// Module state (the timer, the throttle bucket) is deliberately module-level,
// so each test that depends on it re-imports the module through
// vi.resetModules() rather than calling a test-only reset export.

const {
    captureMessageMock,
    captureExceptionMock,
    flushMock,
    checkInMock,
    getClientMock,
} = vi.hoisted(() => ({
    captureMessageMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    flushMock: vi.fn(async () => true),
    checkInMock: vi.fn(
        (_checkIn: Record<string, unknown>, _config?: unknown): string =>
            'check-in-id',
    ),
    getClientMock: vi.fn((): object | undefined => ({})),
}))

vi.mock('@sentry/nextjs', () => ({
    captureMessage: captureMessageMock,
    captureException: captureExceptionMock,
    flush: flushMock,
    captureCheckIn: checkInMock,
    getClient: getClientMock,
}))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        SENDLY_BASE_URL: undefined as string | undefined,
        SENDLY_API_KEY: 'sk_test_key' as string | undefined,
        SENDLY_FROM_EMAIL: 'no_reply@grabcaramel.com',
        EMAIL_DELIVERY_HEALTH_ENABLED: undefined as
            'true' | 'false' | undefined,
        EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES: 60,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { checkMock } = vi.hoisted(() => ({
    checkMock: vi.fn(),
}))
vi.mock('@/lib/emailDeliveryHealth', async importOriginal => {
    const actual =
        await importOriginal<typeof import('@/lib/emailDeliveryHealth')>()
    return { ...actual, checkEmailDeliveryHealth: checkMock }
})

function report(
    overrides: Partial<EmailDeliveryHealthReport> = {},
): EmailDeliveryHealthReport {
    return {
        status: 'ok',
        windowStart: '2026-09-16T12:00:00.000Z',
        windowEnd: '2026-09-16T13:00:00.000Z',
        scanned: 3,
        failed: 0,
        delayed: 0,
        stuckPending: 0,
        byStatus: { DELIVERED: 3 },
        senderDomain: 'grabcaramel.com',
        pagesFetched: 1,
        truncated: false,
        ...overrides,
    }
}

/** Fresh module instance, so the timer + throttle state start clean. */
async function freshMonitor() {
    vi.resetModules()
    return import('@/lib/emailDeliveryHealthMonitor')
}

beforeEach(() => {
    captureMessageMock.mockClear()
    captureExceptionMock.mockClear()
    flushMock.mockClear()
    checkInMock.mockReset()
    checkInMock.mockImplementation(() => 'check-in-id')
    getClientMock.mockReset()
    getClientMock.mockImplementation(() => ({}))
    checkMock.mockReset()
    checkMock.mockResolvedValue(report())
    envMock.SENDLY_API_KEY = 'sk_test_key'
    envMock.EMAIL_DELIVERY_HEALTH_ENABLED = undefined
    envMock.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES = 60
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('decideEmailDeliveryHealthMonitor', () => {
    it('is on by default in production once Sendly is configured', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'production',
                SENDLY_API_KEY: 'sk_key',
            }),
        ).toEqual({ enabled: true, reason: 'production default' })
    })

    it('is off by default outside production, and forceable with the env var', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'development',
                SENDLY_API_KEY: 'sk_key',
            }).enabled,
        ).toBe(false)
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'development',
                SENDLY_API_KEY: 'sk_key',
                EMAIL_DELIVERY_HEALTH_ENABLED: 'true',
            }).enabled,
        ).toBe(true)
    })

    it('lets a production deploy opt OUT explicitly', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        const decision = decideEmailDeliveryHealthMonitor({
            NODE_ENV: 'production',
            SENDLY_API_KEY: 'sk_key',
            EMAIL_DELIVERY_HEALTH_ENABLED: 'false',
        })
        expect(decision.enabled).toBe(false)
        expect(decision.reason).toContain('EMAIL_DELIVERY_HEALTH_ENABLED=false')
    })

    it('stays off — with a named reason — when Sendly is not configured at all', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        const decision = decideEmailDeliveryHealthMonitor({
            NODE_ENV: 'production',
            EMAIL_DELIVERY_HEALTH_ENABLED: 'true',
        })
        expect(decision.enabled).toBe(false)
        expect(decision.reason).toContain('SENDLY_API_KEY')
    })
})

describe('reportEmailDeliveryHealth', () => {
    it('says nothing to Sentry for a healthy or skipped window', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        await expect(reportEmailDeliveryHealth(report())).resolves.toBe(false)
        await expect(
            reportEmailDeliveryHealth(report({ status: 'skipped' })),
        ).resolves.toBe(false)
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('raises ONE error-level event carrying counts but no recipient data', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        const sent = await reportEmailDeliveryHealth(
            report({
                status: 'degraded',
                failed: 2,
                byStatus: { BOUNCED: 2, DELIVERED: 1 },
            }),
        )
        expect(sent).toBe(true)
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
        const [message, options] = captureMessageMock.mock.calls[0]
        expect(message).toBe('Transactional email delivery degraded')
        expect(options.level).toBe('error')
        expect(options.tags.surface).toBe('email-delivery-health')
        expect(options.extra.failed).toBe(2)
        expect(JSON.stringify(options.extra)).not.toContain('@')
        expect(flushMock).toHaveBeenCalled()
    })

    it('downgrades a no-failure window (only stuck sends) to warning level', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        await reportEmailDeliveryHealth(
            report({ status: 'degraded', failed: 0, stuckPending: 4 }),
        )
        expect(captureMessageMock.mock.calls[0][1].level).toBe('warning')
    })

    it('reports a coverage gap (incomplete) to Sentry as a warning, never silently', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        const sent = await reportEmailDeliveryHealth(
            report({
                status: 'incomplete',
                truncated: true,
                reason: 'page budget exhausted',
            }),
        )
        expect(sent).toBe(true)
        const [message, options] = captureMessageMock.mock.calls[0]
        expect(message).toBe(
            'Transactional email delivery health check incomplete',
        )
        expect(options.level).toBe('warning')
        expect(options.extra.truncated).toBe(true)
    })

    it('reports an unreachable provider as an error-level event', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        await reportEmailDeliveryHealth(
            report({ status: 'error', reason: 'Sendly list emails failed' }),
        )
        const [message, options] = captureMessageMock.mock.calls[0]
        expect(message).toBe('Transactional email delivery health check failed')
        expect(options.level).toBe('error')
    })

    it('sends at most one event per clock hour, then resumes in the next hour', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        const bad = report({ status: 'degraded', failed: 1 })
        const first = new Date('2026-09-16T13:05:00.000Z')
        const sameHour = new Date('2026-09-16T13:55:00.000Z')
        const nextHour = new Date('2026-09-16T14:01:00.000Z')

        await expect(reportEmailDeliveryHealth(bad, first)).resolves.toBe(true)
        await expect(reportEmailDeliveryHealth(bad, sameHour)).resolves.toBe(
            false,
        )
        await expect(reportEmailDeliveryHealth(bad, nextHour)).resolves.toBe(
            true,
        )
        expect(captureMessageMock).toHaveBeenCalledTimes(2)
    })

    it('never throws when Sentry itself is broken', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        captureMessageMock.mockImplementationOnce(() => {
            throw new Error('sentry transport down')
        })
        await expect(
            reportEmailDeliveryHealth(
                report({ status: 'degraded', failed: 1 }),
            ),
        ).resolves.toBe(false)
    })
})

describe('runEmailDeliveryHealthCycle', () => {
    it('logs a clean window and reports nothing', async () => {
        const { runEmailDeliveryHealthCycle } = await freshMonitor()
        const result = await runEmailDeliveryHealthCycle()
        expect(result.status).toBe('ok')
        expect(captureMessageMock).not.toHaveBeenCalled()
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('[email-health] ok'),
        )
    })

    it('passes the configured interval through as the window length', async () => {
        envMock.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES = 15
        const { runEmailDeliveryHealthCycle } = await freshMonitor()
        await runEmailDeliveryHealthCycle()
        expect(checkMock).toHaveBeenCalledWith(
            expect.objectContaining({ windowMinutes: 15 }),
        )
    })

    it('reports a degraded window to Sentry', async () => {
        checkMock.mockResolvedValue(report({ status: 'degraded', failed: 3 }))
        const { runEmailDeliveryHealthCycle } = await freshMonitor()
        await runEmailDeliveryHealthCycle()
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
    })
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Boot at 10:50 UTC: the default hourly slot is :23, so the first run is 11:23.
const BOOT_AT_10_50 = '2026-10-27T10:50:00.000Z'
const SLOT_11_23_MS = Date.parse('2026-10-27T11:23:00.000Z')
const BOOT_TO_SLOT_MS = SLOT_11_23_MS - Date.parse(BOOT_AT_10_50)

/** Fake clock at the fixed boot time, monitor forced on. */
async function startedMonitor() {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(BOOT_AT_10_50))
    const mod = await freshMonitor()
    envMock.EMAIL_DELIVERY_HEALTH_ENABLED = 'true'
    return mod
}

describe('startEmailDeliveryHealthMonitor', () => {
    it('does not run the check at boot, nor boot + 60 minutes: a :50 boot runs at :23', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()

        const decision = startEmailDeliveryHealthMonitor()
        expect(decision.enabled).toBe(true)
        expect(decision.reason).toContain('2026-10-27T11:23:00.000Z')
        expect(checkMock).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS - 1)
        expect(checkMock).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(Date.now()).toBe(SLOT_11_23_MS)
        expect(checkMock).toHaveBeenCalledTimes(1)
    })

    it('a boot at :22 (inside the 2 minute guard) waits for :23 of the next hour', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        vi.setSystemTime(new Date('2026-10-27T10:22:00.000Z'))

        expect(startEmailDeliveryHealthMonitor().reason).toContain(
            '2026-10-27T11:23:00.000Z',
        )
        await vi.advanceTimersByTimeAsync(5 * MINUTE)
        expect(checkMock).not.toHaveBeenCalled()
    })

    it('runs every period after that, on the wall clock', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        const times: number[] = []
        checkMock.mockImplementation(async () => {
            times.push(Date.now())
            return report()
        })

        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS + 2 * HOUR)

        expect(times).toEqual([
            SLOT_11_23_MS,
            SLOT_11_23_MS + HOUR,
            SLOT_11_23_MS + 2 * HOUR,
        ])
    })

    it('follows EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES: 15 minutes runs at :08 :23 :38 :53', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        envMock.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES = 15
        const minutes: number[] = []
        checkMock.mockImplementation(async () => {
            minutes.push(new Date().getUTCMinutes())
            return report()
        })

        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(HOUR)

        expect(minutes).toEqual([53, 8, 23, 38])
    })

    it('starts nothing when the decision says off', async () => {
        vi.useFakeTimers()
        const { startEmailDeliveryHealthMonitor } = await freshMonitor()
        envMock.EMAIL_DELIVERY_HEALTH_ENABLED = 'false'

        expect(startEmailDeliveryHealthMonitor().enabled).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(3 * HOUR)
        expect(checkMock).not.toHaveBeenCalled()
        expect(checkInMock).not.toHaveBeenCalled()
    })

    it('does not start outside production unless forced (no timer)', async () => {
        vi.useFakeTimers()
        vi.stubEnv('NODE_ENV', 'test')
        const { startEmailDeliveryHealthMonitor } = await freshMonitor()

        const decision = startEmailDeliveryHealthMonitor()

        expect(decision.enabled).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        vi.unstubAllEnvs()
    })

    it('is idempotent — a second call does not add a second timer', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()

        startEmailDeliveryHealthMonitor()
        startEmailDeliveryHealthMonitor()
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
        expect(checkMock).toHaveBeenCalledTimes(1)
    })

    it('keeps ticking after a tick whose cycle never settles (the schedule is re-armed BEFORE the cycle is awaited)', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        checkMock.mockImplementationOnce(() => new Promise(() => {}))

        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
        expect(checkMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(HOUR)

        // The hung cycle still holds the overlap guard, so the second tick is
        // skipped (and checks in as error) rather than stacking a second cycle,
        // but the schedule is still alive.
        expect(checkMock).toHaveBeenCalledTimes(1)
        expect(console.warn).toHaveBeenCalledWith(
            '[email-health] previous cycle still running, skipped',
        )
        expect(vi.getTimerCount()).toBe(1)
        expect(
            checkInMock.mock.calls
                .map(call => call[0].status)
                .filter(status => status === 'error'),
        ).toHaveLength(1)
    })

    it('a timed-out check (error report) releases the overlap guard, so the next tick runs instead of being skipped (T-9447)', async () => {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        checkMock.mockResolvedValueOnce(
            report({
                status: 'error',
                reason: 'Sendly request timed out after 15000 ms',
            }),
        )

        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
        await vi.advanceTimersByTimeAsync(HOUR)

        expect(checkMock).toHaveBeenCalledTimes(2)
        expect(console.warn).not.toHaveBeenCalledWith(
            '[email-health] previous cycle still running, skipped',
        )
    })
})

describe('the scheduled run checks in to the Sentry cron monitor', () => {
    async function tickOnce() {
        const { startEmailDeliveryHealthMonitor } = await startedMonitor()
        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(BOOT_TO_SLOT_MS)
    }
    const statuses = () => checkInMock.mock.calls.map(call => call[0].status)

    it('a clean window sends in_progress then ok', async () => {
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'ok'])
        expect(checkInMock.mock.calls[1]![0]).toMatchObject({
            monitorSlug: 'caramel-email-delivery-health',
            checkInId: 'check-in-id',
        })
    })

    it.each(['degraded', 'incomplete'] as const)(
        'a %s window is still ok for the cron monitor: the check ran, the finding is its own Sentry event',
        async status => {
            checkMock.mockResolvedValue(report({ status, failed: 2 }))
            await tickOnce()

            expect(statuses()).toEqual(['in_progress', 'ok'])
            expect(captureMessageMock).toHaveBeenCalledTimes(1)
        },
    )

    it.each(['error', 'skipped'] as const)(
        'a %s report (the check could not run) checks in as error',
        async status => {
            checkMock.mockResolvedValue(report({ status, reason: 'down' }))
            await tickOnce()

            expect(statuses()).toEqual(['in_progress', 'error'])
        },
    )

    it('a cycle that throws checks in as error and is captured', async () => {
        checkMock.mockRejectedValue(new Error('boom'))
        await tickOnce()

        expect(statuses()).toEqual(['in_progress', 'error'])
        // The pre-cron-monitor tag stays so alert rules keyed on it still match.
        expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
            tags: {
                surface: 'email-delivery-health',
                area: 'email-health.timer',
            },
        })
    })

    it('carries the :23 hourly crontab monitor config on every check-in, closing one too', async () => {
        await tickOnce()

        expect(checkInMock).toHaveBeenCalledTimes(2)
        for (const call of checkInMock.mock.calls) {
            expect(call[1]).toEqual({
                schedule: { type: 'crontab', value: '23 * * * *' },
                timezone: 'UTC',
                checkinMargin: 30,
                maxRuntime: 5,
                failureIssueThreshold: 2,
                recoveryThreshold: 1,
            })
        }
    })

    it('the monitor crontab is built from the timer schedule, for every period', async () => {
        const {
            emailDeliveryHealthMonitorConfig,
            emailDeliveryHealthSchedule,
        } = await freshMonitor()

        for (const period of [15, 60, 120, 360]) {
            const config = emailDeliveryHealthMonitorConfig(period)
            expect(config.schedule.value).toBe(
                wallClockCrontab(emailDeliveryHealthSchedule(period)),
            )
            expect(config.checkinMargin).toBeLessThan(period)
        }
        expect(emailDeliveryHealthMonitorConfig(15).schedule.value).toBe(
            '8-59/15 * * * *',
        )
    })

    it('without a Sentry client the check still runs and no check-in is sent', async () => {
        getClientMock.mockImplementation(() => undefined)
        await tickOnce()

        expect(checkMock).toHaveBeenCalledTimes(1)
        expect(checkInMock).not.toHaveBeenCalled()
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('cron check-ins DISABLED'),
        )
    })
})
