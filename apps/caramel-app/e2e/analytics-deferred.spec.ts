import { expect, test, type Page } from '@playwright/test'
import { firstLinkedStoreDomain } from './support/stores'

// Third-party analytics stay off the page's critical path.
//
// Lighthouse mobile with applied throttling on a prod store page (2026-09-26):
// gtag.js (173 KB) was requested at ~0.7 s, while the app's own JS was still
// downloading (the load event fired at ~5.6 s), and PostHog fetched its
// surveys bundle although the project has no surveys. Now gtag.js is
// next/script `lazyOnload` and PostHog runs with disable_surveys.
//
// Hotjar is not covered: it initialises in an effect and already starts after
// the load event, and gating it on an idle callback measured no difference
// (A/B, 2026-09-26). Its cost (350–450 ms of blocking time on prod) only goes
// away if it is removed.
//
// Real browser, real server, real third-party requests; nothing is mocked or
// written. Timing comes from the page's own Resource Timing clock: a script
// counts as deferred when its fetch started at or after the load event.

async function openStorePage(page: Page) {
    // The default Resource Timing buffer holds 250 entries; a store page's
    // logos can fill it before the late scripts are recorded.
    await page.addInitScript(() =>
        performance.setResourceTimingBufferSize(5000),
    )
    const site = await firstLinkedStoreDomain(page)
    const requested: string[] = []
    page.on('request', request => requested.push(request.url()))
    const response = await page.goto(`/coupons/${site}`, { waitUntil: 'load' })
    expect(response?.status(), 'store page status').toBe(200)
    return requested
}

/** Wait for a resource matching `pattern`, then report when it started
 *  relative to the load event (both on the page's performance clock). */
async function startRelativeToLoad(page: Page, pattern: RegExp, what: string) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    source =>
                        performance
                            .getEntriesByType('resource')
                            .some(entry => new RegExp(source).test(entry.name)),
                    pattern.source,
                ),
            { message: `${what} never loaded`, timeout: 30_000 },
        )
        .toBe(true)
    return page.evaluate(source => {
        const entry = performance
            .getEntriesByType('resource')
            .find(e => new RegExp(source).test(e.name))
        const [nav] = performance.getEntriesByType(
            'navigation',
        ) as PerformanceNavigationTiming[]
        return {
            startTime: Math.round(entry?.startTime ?? -1),
            loadEventStart: Math.round(nav.loadEventStart),
        }
    }, pattern.source)
}

test.describe('Analytics scripts load after the page, not with it', () => {
    test('gtag.js is fetched after the load event', async ({ page }) => {
        await openStorePage(page)
        const t = await startRelativeToLoad(
            page,
            /googletagmanager\.com\/gtag\/js/,
            'gtag.js',
        )
        expect(t.startTime, JSON.stringify(t)).toBeGreaterThanOrEqual(
            t.loadEventStart,
        )
    })

    test('the GA pageview queued before gtag.js loaded is still sent', async ({
        page,
    }) => {
        const requested = await openStorePage(page)
        await startRelativeToLoad(
            page,
            /googletagmanager\.com\/gtag\/js/,
            'gtag.js',
        )
        const gtagUrl = requested.find(url => /\/gtag\/js\?/.test(url)) ?? ''
        test.skip(
            !new URL(gtagUrl).searchParams.get('id'),
            'no GA measurement id configured here',
        )
        // The page_view was queued in dataLayer by the inline init; gtag.js
        // must replay it once it arrives.
        await expect
            .poll(
                () =>
                    requested.some(
                        url =>
                            /google-analytics\.com\/g\/collect/.test(url) &&
                            /[?&]en=page_view(&|$)/.test(url),
                    ),
                { message: 'GA page_view never sent', timeout: 30_000 },
            )
            .toBe(true)
    })

    test('PostHog does not fetch the surveys bundle', async ({ page }) => {
        const requested = await openStorePage(page)
        // PostHog asks for its remote config right after init; the surveys
        // bundle used to follow it. Give both time to happen.
        await startRelativeToLoad(
            page,
            /googletagmanager\.com\/gtag\/js/,
            'gtag.js',
        )
        await page.waitForLoadState('networkidle')
        // posthog-js fetches /array/<project token>/config.js on init.
        const posthogActive = requested.some(url =>
            /\/array\/phc_[^/]+\/config/.test(url),
        )
        test.skip(!posthogActive, 'PostHog capture is not configured here')
        expect(
            requested.filter(url => /\/static\/surveys[\w.-]*\.js/.test(url)),
        ).toEqual([])
    })
})
