// @vitest-environment jsdom
import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the `install_cta_click` vocabulary: every install CTA reports
// `{ store, placement, path }` (path filled by trackGrowthEvent from the page
// it sat on). Before this, only the in-content callouts and /apps fired a
// click event; the homepage browser buttons (~380 store-link clicks 2026-10-01
// onward in PostHog autocapture) fired nothing custom.
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
    firstTouchMock.captureFirstTouch.mockReset().mockReturnValue(null)
    window.history.pushState({}, '', '/')
})

describe('install_cta_click properties', () => {
    it.each([
        'home_features',
        'coupons_section',
        'profile_checklist',
        'profile_favorites',
    ] as const)('%s reports store, placement and the page path', placement => {
        window.history.pushState({}, '', '/coupons/example.com')
        trackGrowthEvent('install_cta_click', { store: 'chrome', placement })
        expect(posthogBrowserMock.capturePosthog).toHaveBeenCalledTimes(1)
        const [event, props] = posthogBrowserMock.capturePosthog.mock.calls[0]!
        expect(event).toBe('install_cta_click')
        expect(props).toEqual({
            store: 'chrome',
            placement,
            path: '/coupons/example.com',
        })
    })

    it('does not add a path to other growth events', () => {
        trackGrowthEvent('store_badge_click', { store: 'chrome' })
        expect(posthogBrowserMock.capturePosthog.mock.calls[0]![1]).toEqual({
            store: 'chrome',
        })
    })
})
