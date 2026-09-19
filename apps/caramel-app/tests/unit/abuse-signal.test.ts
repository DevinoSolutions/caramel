// tests/unit/abuse-signal.test.ts
//
// Pins the contract of src/lib/abuseSignal.ts: every rejection breadcrumbs,
// SUSTAINED abuse escalates exactly ONCE per client per window, a second
// client is tracked independently, and nothing the reporter touches can throw
// into the request path. The regression these guard against is the real one
// measured on prod 2026-09-16: 3377 rejections (2690 from a single scraper)
// that produced zero Sentry issues and zero analytics events.
import {
    hashClientIp,
    reportRateLimitRejection,
    resetAbuseCountersForTest,
    SUSTAINED_THRESHOLD,
} from '@/lib/abuseSignal'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const addBreadcrumb = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()

vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: (...args: unknown[]) => addBreadcrumb(...args),
    captureMessage: (...args: unknown[]) => captureMessage(...args),
    captureException: (...args: unknown[]) => captureException(...args),
}))

interface CaptureArgs {
    event: string
    distinctId: string
    properties?: Record<string, unknown>
}
const captureServerEvent = vi.fn(async (_args: CaptureArgs) => true)
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: (args: CaptureArgs) => captureServerEvent(args),
}))

const rejection = (ip: string, path = '/api/coupons') => ({
    ip,
    path,
    kind: 'read',
    userAgent: 'DealsbuckCouponBot/1.0',
    retryAfterSec: 4,
})

async function reportTimes(ip: string, times: number): Promise<number> {
    let escalations = 0
    for (let i = 0; i < times; i += 1) {
        if (await reportRateLimitRejection(rejection(ip))) escalations += 1
    }
    return escalations
}

describe('reportRateLimitRejection', () => {
    beforeEach(() => {
        resetAbuseCountersForTest()
        addBreadcrumb.mockClear()
        captureMessage.mockClear()
        captureException.mockClear()
        captureServerEvent.mockClear()
        captureServerEvent.mockImplementation(async () => true)
    })

    it('breadcrumbs every rejection without escalating below the threshold', async () => {
        const escalations = await reportTimes('203.0.113.7', 5)

        expect(escalations).toBe(0)
        expect(addBreadcrumb).toHaveBeenCalledTimes(5)
        expect(captureMessage).not.toHaveBeenCalled()
        expect(captureServerEvent).not.toHaveBeenCalled()
    })

    it('escalates exactly once when one client crosses the threshold, and stays quiet after', async () => {
        const escalations = await reportTimes(
            '203.0.113.9',
            SUSTAINED_THRESHOLD + 25,
        )

        expect(escalations).toBe(1)
        expect(captureMessage).toHaveBeenCalledTimes(1)
        expect(captureServerEvent).toHaveBeenCalledTimes(1)

        const [message, options] = captureMessage.mock.calls[0] as [
            string,
            { tags: Record<string, string>; extra: Record<string, unknown> },
        ]
        expect(message).toContain('Sustained rate-limit abuse')
        expect(options.tags.surface).toBe('rate-limit-abuse')
        expect(options.extra.ip).toBe('203.0.113.9')
        expect(options.extra.rejections_in_window).toBe(SUSTAINED_THRESHOLD)
        expect(options.extra.paths).toBe('/api/coupons')
    })

    it('sends a hashed client id to analytics, never the raw IP', async () => {
        await reportTimes('203.0.113.11', SUSTAINED_THRESHOLD)

        const args = captureServerEvent.mock.calls[0]?.[0] as CaptureArgs
        expect(args.event).toBe('api_abuse_detected')
        expect(args.distinctId).toBe(`ip:${hashClientIp('203.0.113.11')}`)
        expect(args.distinctId).not.toContain('203.0.113.11')
    })

    it('counts each client separately', async () => {
        await reportTimes('198.51.100.1', SUSTAINED_THRESHOLD - 1)
        await reportTimes('198.51.100.2', 3)

        expect(captureMessage).not.toHaveBeenCalled()

        expect(await reportRateLimitRejection(rejection('198.51.100.1'))).toBe(
            true,
        )
        expect(captureMessage).toHaveBeenCalledTimes(1)
    })

    it('never throws when the analytics capture fails', async () => {
        captureServerEvent.mockImplementation(async () => {
            throw new Error('posthog down')
        })

        await expect(
            reportTimes('198.51.100.9', SUSTAINED_THRESHOLD),
        ).resolves.toBe(0)
        expect(captureException).toHaveBeenCalledTimes(1)
    })
})
