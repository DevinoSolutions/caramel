// @vitest-environment jsdom
import { reportUserVisibleFailure } from '@/lib/feedback/reportUserVisibleFailure'
import * as Sentry from '@sentry/nextjs'
import posthog from 'posthog-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Sentry always fires; PostHog + a downstream prompt fire at most once per
// operation+errorCode per browser session.
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(() => 'evt_abc'),
}))
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }))
// Force PostHog "active" so the capture branch is exercised without a real init.
vi.mock('@/lib/analytics/identity', () => ({ isPosthogActive: () => true }))

const captureException = vi.mocked(Sentry.captureException)
const phCapture = vi.mocked(posthog.capture)

describe('reportUserVisibleFailure', () => {
    beforeEach(() => {
        sessionStorage.clear()
        captureException.mockClear()
        phCapture.mockClear()
    })

    it('reports to Sentry AND PostHog on first occurrence, returning that Sentry event id', () => {
        const result = reportUserVisibleFailure({
            error: new Error('boom'),
            operation: 'checkout',
            errorCode: 'E_PAY',
        })

        expect(result).toEqual({ sentryEventId: 'evt_abc', rateLimited: false })
        expect(captureException).toHaveBeenCalledTimes(1)
        expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
            tags: { operation: 'checkout' },
        })
        expect(phCapture).toHaveBeenCalledTimes(1)
        const [event, props] = phCapture.mock.calls[0]
        expect(event).toBe('user_visible_operation_failed')
        expect(props).toMatchObject({
            sentry_event_id: 'evt_abc',
            operation: 'checkout',
            error_code: 'E_PAY',
            app_id: 'caramel',
            route: expect.any(String),
        })
    })

    it('rate-limits the SAME fingerprint: Sentry still fires, PostHog does not, rateLimited=true', () => {
        const input = {
            error: new Error('boom'),
            operation: 'checkout',
            errorCode: 'E_PAY',
        }
        reportUserVisibleFailure(input)
        const second = reportUserVisibleFailure(input)

        expect(second.rateLimited).toBe(true)
        expect(captureException).toHaveBeenCalledTimes(2)
        expect(phCapture).toHaveBeenCalledTimes(1)
    })

    it('a different errorCode is a different fingerprint (not rate-limited)', () => {
        reportUserVisibleFailure({
            error: new Error('boom'),
            operation: 'checkout',
            errorCode: 'E_PAY',
        })
        const other = reportUserVisibleFailure({
            error: new Error('boom'),
            operation: 'checkout',
            errorCode: 'E_NETWORK',
        })

        expect(other.rateLimited).toBe(false)
        expect(phCapture).toHaveBeenCalledTimes(2)
    })
})
