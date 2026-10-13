import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// install_cta_click / store_badge_click / signup_started carry the visitor's
// first-touch properties on the EVENT; the other growth events do not.
// posthogBrowser and firstTouch are TEST DOUBLES (…Mock).

const { posthogBrowserMock } = vi.hoisted(() => ({
    posthogBrowserMock: { capturePosthog: vi.fn() },
}))
vi.mock('@/lib/analytics/posthogBrowser', () => posthogBrowserMock)

const { firstTouchMock } = vi.hoisted(() => ({
    firstTouchMock: { captureFirstTouch: vi.fn() },
}))
vi.mock('@/lib/analytics/firstTouch', () => firstTouchMock)

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

beforeEach(() => {
    posthogBrowserMock.capturePosthog.mockReset()
    firstTouchMock.captureFirstTouch.mockReset().mockReturnValue({
        utm_source: 'reddit',
        msclkid: 'm1',
        captured_at: '2026-10-01T00:00:00.000Z',
    })
})

describe('trackGrowthEvent first-touch enrichment', () => {
    it.each([
        'install_cta_click',
        'store_badge_click',
        'signup_started',
    ] as const)('%s carries first_* properties next to its own', name => {
        trackGrowthEvent(name, { placement: 'honey_extension' })
        expect(posthogBrowserMock.capturePosthog).toHaveBeenCalledTimes(1)
        const [event, props] = posthogBrowserMock.capturePosthog.mock.calls[0]!
        expect(event).toBe(name)
        expect(props).toEqual({
            first_utm_source: 'reddit',
            first_msclkid: 'm1',
            placement: 'honey_extension',
        })
    })

    it('signup_started carries the chosen method', () => {
        trackGrowthEvent('signup_started', { method: 'apple' })
        expect(
            posthogBrowserMock.capturePosthog.mock.calls[0]![1],
        ).toMatchObject({
            method: 'apple',
            first_utm_source: 'reddit',
        })
    })

    it('a visitor with no record sends just the event properties', () => {
        firstTouchMock.captureFirstTouch.mockReturnValue(null)
        trackGrowthEvent('install_cta_click', {
            placement: 'compare_extensions',
        })
        expect(posthogBrowserMock.capturePosthog.mock.calls[0]![1]).toEqual({
            placement: 'compare_extensions',
        })
    })

    it('other growth events are untouched (no first-touch read at all)', () => {
        trackGrowthEvent('prompt_shown', { prompt_id: 'install_extension' })
        expect(posthogBrowserMock.capturePosthog.mock.calls[0]![1]).toEqual({
            prompt_id: 'install_extension',
        })
        expect(firstTouchMock.captureFirstTouch).not.toHaveBeenCalled()
    })
})
