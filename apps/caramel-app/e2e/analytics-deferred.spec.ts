import { expect, test, type Page, type Request } from '@playwright/test'
import { firstLinkedStoreDomain } from './support/stores'

// Third-party analytics stay off the page's critical path.
//
// Lighthouse mobile with applied throttling on a prod store page (2026-09-26):
// gtag.js (173 KB) was requested at ~0.7 s and downloaded until ~5.2 s, sharing
// slow 4G with the app's own JS the whole way (the load event fired at
// ~5.6 s); PostHog fetched its surveys bundle (30 KB, 102 KB to parse)
// although the project has no surveys. Now gtag.js is next/script
// `lazyOnload` and PostHog runs with disable_surveys.
//
// Hotjar is not covered: it initialises in an effect and already starts after
// the load event, and gating it on an idle callback measured no difference
// (A/B, 2026-09-26). Its cost (350–450 ms of blocking time on prod) only goes
// away if it is removed.
//
// Real browser, real server, real third-party requests, nothing mocked. The
// only writes are the analytics hits any page view sends. Timing comes from
// the page's own Resource Timing clock: a script counts as deferred when its
// fetch started at or after the load event.

// First compile of two pages in `next dev` plus third-party waits.
test.slow()

async function openStorePage(page: Page) {
    // The default Resource Timing buffer holds 250 entries; a store page's
    // logos can fill it before the late scripts are recorded.
    await page.addInitScript(() =>
        performance.setResourceTimingBufferSize(5000),
    )
    const site = await firstLinkedStoreDomain(page)
    const requests: Request[] = []
    const response = await page.goto(`/coupons/${site}`, { waitUntil: 'load' })
    expect(response?.status(), 'store page status').toBe(200)
    // Attached after the store page's navigation committed, so nothing the
    // previous page (/supported-stores) sends can land in this list; anything
    // the store page requested before `load` is covered by Resource Timing.
    page.on('request', request => requests.push(request))
    return { site, requests }
}

/** Wait for a resource matching `pattern`, then report when it started
 *  relative to the load event (both on the page's performance clock). */
async function resourceRelativeToLoad(
    page: Page,
    pattern: RegExp,
    what: string,
) {
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
            { message: `${what} never loaded`, timeout: 20_000 },
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

const GTAG_JS = /googletagmanager\.com\/gtag\/js/

/** Whether this deploy has a GA measurement id: providers.tsx renders the
 *  inline `gtag-init` script only then, from an effect that runs before the
 *  one stamping html[data-hydrated]. */
async function gaConfigured(page: Page): Promise<boolean> {
    await page.locator('html[data-hydrated="true"]').waitFor({
        state: 'attached',
    })
    return (await page.locator('script#gtag-init').count()) > 0
}

/** A GA4 page_view hit for `path`. GA4 sends single hits as GET query params
 *  and batches as a POST body with one hit per line, each hit carrying the
 *  same key=value encoding; `dl` is the page URL the hit is attributed to. */
function isPageViewFor(request: Request, path: string): boolean {
    const url = new URL(request.url())
    if (
        !/(^|\.)google-analytics\.com$|^analytics\.google\.com$/.test(
            url.hostname,
        ) ||
        !url.pathname.endsWith('/g/collect')
    ) {
        return false
    }
    const hits = [
        url.search.slice(1),
        ...(request.postData() ?? '').split('\n'),
    ]
    return hits.some(hit => {
        // A batched hit only carries its own params; shared ones (dl) stay
        // in the query string.
        const params = new URLSearchParams(`${url.search.slice(1)}&${hit}`)
        return (
            params.getAll('en').includes('page_view') &&
            new URL(params.get('dl') ?? 'about:blank').pathname === path
        )
    })
}

test.describe('Analytics scripts load after the page, not with it', () => {
    test('gtag.js is fetched after the load event', async ({ page }) => {
        await openStorePage(page)
        test.skip(
            !(await gaConfigured(page)),
            'no GA measurement id configured here',
        )
        const t = await resourceRelativeToLoad(page, GTAG_JS, 'gtag.js')
        expect(t.startTime, JSON.stringify(t)).toBeGreaterThanOrEqual(
            t.loadEventStart,
        )
    })

    test('the store page still sends its GA page_view', async ({ page }) => {
        const { site, requests } = await openStorePage(page)
        test.skip(
            !(await gaConfigured(page)),
            'no GA measurement id configured here',
        )
        await resourceRelativeToLoad(page, GTAG_JS, 'gtag.js')
        // The page_view is queued in dataLayer by the inline init before
        // gtag.js arrives; gtag.js must replay it, attributed to this page.
        await expect
            .poll(
                () =>
                    requests.some(request =>
                        isPageViewFor(request, `/coupons/${site}`),
                    ),
                { message: 'GA page_view never sent', timeout: 20_000 },
            )
            .toBe(true)
    })

    test('PostHog does not fetch the surveys bundle', async ({ page }) => {
        const { requests } = await openStorePage(page)
        // posthog-js fetches /array/<project token>/config.js on init and,
        // before this change, requested surveys.js from that config's
        // callback, synchronously.
        const posthogConfig = /\/array\/[^/]+\/config/
        const configLoaded = await resourceRelativeToLoad(
            page,
            posthogConfig,
            'PostHog config',
        ).then(
            () => true,
            // Only the "never loaded" poll can reject here.
            () => false,
        )
        test.skip(!configLoaded, 'PostHog capture is not configured here')
        // Let the config script run and its callbacks fire.
        await page.evaluate(
            () =>
                new Promise(resolve =>
                    requestIdleCallback(resolve, { timeout: 5_000 }),
                ),
        )
        const surveys = [
            ...requests.map(request => request.url()),
            ...(await page.evaluate(() =>
                performance.getEntriesByType('resource').map(e => e.name),
            )),
        ].filter(url => /\/static\/surveys[\w.-]*\.js/.test(url))
        expect(surveys).toEqual([])
    })
})
