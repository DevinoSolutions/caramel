import { expect, test, type Page } from '@playwright/test'
import { firstLinkedStoreDomain } from './support/stores'

// Third-party analytics stay off the page's critical path.
//
// Lighthouse mobile with applied throttling on a prod store page (2026-09-26):
// gtag.js (173 KB) was requested at ~0.76 s, while the app's own JS was still
// downloading; Hotjar cost 350–450 ms of blocking time; PostHog fetched its
// surveys bundle although the project has no surveys. Now gtag.js is
// next/script `lazyOnload`, Hotjar starts through runAfterLoadWhenIdle, and
// PostHog runs with disable_surveys.
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

    test('Hotjar is fetched after the load event', async ({
        page,
        request,
    }) => {
        // Hotjar only starts in production builds; `next dev` (the hermetic
        // e2e-pr lane) is recognisable by its per-file CSS precedence.
        const html = await (await request.get('/supported-stores')).text()
        test.skip(
            /data-precedence="next_/.test(html),
            'Hotjar is production-only; `next dev` never starts it',
        )
        await openStorePage(page)
        const t = await startRelativeToLoad(
            page,
            /static\.hotjar\.com\/c\/hotjar-/,
            'Hotjar',
        )
        expect(t.startTime, JSON.stringify(t)).toBeGreaterThanOrEqual(
            t.loadEventStart,
        )
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
