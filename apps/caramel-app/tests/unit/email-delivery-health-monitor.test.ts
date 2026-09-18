import type { EmailDeliveryHealthReport } from '@/lib/emailDeliveryHealth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The schedule around the delivery check. Caramel owns no cron and no worker,
// so the check rides an unref'd interval on the Next server process. That
// buys three obligations, each pinned below:
//
//   1. the enable decision is a pure table (prod default ON when useSend is
//      configured, env var overrides BOTH ways) — a deploy must never have to
//      guess whether the check is running;
//   2. at most ONE Sentry event per clock hour, so a degraded provider cannot
//      turn into an issue storm, and 'ok' windows are silent;
//   3. the first run is one interval AFTER boot, never at boot — a
//      crash-looping container must not be able to machine-gun Sentry.
//
// Module state (the timer, the throttle bucket) is deliberately module-level,
// so each test that depends on it re-imports the module through
// vi.resetModules() rather than calling a test-only reset export.

const { captureMessageMock, captureExceptionMock, flushMock } = vi.hoisted(
    () => ({
        captureMessageMock: vi.fn(),
        captureExceptionMock: vi.fn(),
        flushMock: vi.fn(async () => true),
    }),
)

vi.mock('@sentry/nextjs', () => ({
    captureMessage: captureMessageMock,
    captureException: captureExceptionMock,
    flush: flushMock,
}))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        USESEND_BASE_URL: 'https://usesend.example.com' as string | undefined,
        USESEND_API_KEY: 'us_test_key' as string | undefined,
        USESEND_FROM_EMAIL: 'no_reply@grabcaramel.com',
        EMAIL_DELIVERY_HEALTH_ENABLED: undefined as
            | 'true'
            | 'false'
            | undefined,
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
        domainId: 14,
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
    checkMock.mockReset()
    checkMock.mockResolvedValue(report())
    envMock.USESEND_API_KEY = 'us_test_key'
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
    it('is on by default in production once useSend is configured', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'production',
                USESEND_API_KEY: 'us_key',
            }),
        ).toEqual({ enabled: true, reason: 'production default' })
    })

    it('is off by default outside production, and forceable with the env var', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'development',
                USESEND_API_KEY: 'us_key',
            }).enabled,
        ).toBe(false)
        expect(
            decideEmailDeliveryHealthMonitor({
                NODE_ENV: 'development',
                USESEND_API_KEY: 'us_key',
                EMAIL_DELIVERY_HEALTH_ENABLED: 'true',
            }).enabled,
        ).toBe(true)
    })

    it('lets a production deploy opt OUT explicitly', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        const decision = decideEmailDeliveryHealthMonitor({
            NODE_ENV: 'production',
            USESEND_API_KEY: 'us_key',
            EMAIL_DELIVERY_HEALTH_ENABLED: 'false',
        })
        expect(decision.enabled).toBe(false)
        expect(decision.reason).toContain('EMAIL_DELIVERY_HEALTH_ENABLED=false')
    })

    it('stays off — with a named reason — when useSend is not configured at all', async () => {
        const { decideEmailDeliveryHealthMonitor } = await freshMonitor()
        const decision = decideEmailDeliveryHealthMonitor({
            NODE_ENV: 'production',
            EMAIL_DELIVERY_HEALTH_ENABLED: 'true',
        })
        expect(decision.enabled).toBe(false)
        expect(decision.reason).toContain('USESEND_API_KEY')
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

    it('reports an unreachable provider as an error-level event', async () => {
        const { reportEmailDeliveryHealth } = await freshMonitor()
        await reportEmailDeliveryHealth(
            report({ status: 'error', reason: 'useSend GET /emails failed' }),
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

describe('startEmailDeliveryHealthMonitor', () => {
    it('does not run the check at boot — only one interval later', async () => {
        vi.useFakeTimers()
        const { startEmailDeliveryHealthMonitor } = await freshMonitor()
        envMock.EMAIL_DELIVERY_HEALTH_ENABLED = 'true'

        const decision = startEmailDeliveryHealthMonitor()
        expect(decision.enabled).toBe(true)
        expect(checkMock).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(checkMock).toHaveBeenCalledTimes(1)
    })

    it('starts nothing when the decision says off', async () => {
        vi.useFakeTimers()
        const { startEmailDeliveryHealthMonitor } = await freshMonitor()
        envMock.EMAIL_DELIVERY_HEALTH_ENABLED = 'false'

        expect(startEmailDeliveryHealthMonitor().enabled).toBe(false)
        await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
        expect(checkMock).not.toHaveBeenCalled()
    })

    it('is idempotent — a second call does not add a second interval', async () => {
        vi.useFakeTimers()
        const { startEmailDeliveryHealthMonitor } = await freshMonitor()
        envMock.EMAIL_DELIVERY_HEALTH_ENABLED = 'true'

        startEmailDeliveryHealthMonitor()
        startEmailDeliveryHealthMonitor()
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(checkMock).toHaveBeenCalledTimes(1)
    })
})
