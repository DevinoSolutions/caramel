import { expect, test, type Page } from '@playwright/test'
import { firstLinkedStoreDomain } from './support/stores'

// The stylesheet ships inside the HTML, so a first visit paints without
// waiting on a second round trip.
//
// Lighthouse mobile with applied throttling (2026-09-25, a store page): the
// HTML had fully arrived at 252 ms, but the page's one render-blocking
// stylesheet was requested at 51 ms and only started arriving at 645 ms, so
// nothing (the hero text included) painted until ~980 ms. next.config.mjs now
// sets experimental.inlineCss, which puts the CSS in a <style> in the <head>.
//
// Production builds only: `next dev` always uses <link> tags, so the spec
// skips when the server is `next dev` (the hermetic e2e-pr lane); the
// compose-build CI job asserts the same thing on a real production build
// there. It runs against every production build: e2e-push, prod, and a local
// `pnpm dev` (the root compose).
//
// JavaScript is off: this is the page a browser can paint before hydration.

test.use({ javaScriptEnabled: false })

// The direct signal for `next dev`: it tags each stylesheet with
// data-precedence="next_<path>" (a per-file precedence keeps HMR ordering);
// a production build uses "next", inlined or not
// (next/dist/server/app-render/render-css-resource.js). A production build
// that regressed to a <link> still says "next", so it still fails below.
test.beforeEach(async ({ request }) => {
    const html = await (await request.get('/supported-stores')).text()
    test.skip(
        /data-precedence="next_/.test(html),
        '`next dev` never inlines CSS (the compose-build CI job covers this lane)',
    )
})

async function stylesheetRequests(page: Page, path: string) {
    const requested: string[] = []
    page.on('request', request => {
        if (request.resourceType() === 'stylesheet') {
            requested.push(request.url())
        }
    })
    const response = await page.goto(path, { waitUntil: 'load' })
    expect(response?.status(), `${path} status`).toBe(200)
    return requested
}

async function expectStyledFromInlineCss(page: Page, path: string) {
    const requested = await stylesheetRequests(page, path)
    expect(requested, `${path} requested a stylesheet`).toEqual([])
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0)
    await expect(page.locator('head style').first()).toBeAttached()
    // The inline CSS actually applies, not just exists: the h1 is
    // font-extrabold on every page checked here.
    await expect(page.locator('main h1').first()).toHaveCSS(
        'font-weight',
        '800',
    )
}

test.describe('CSS is inlined into the HTML', () => {
    test('/supported-stores', async ({ page }) => {
        await expectStyledFromInlineCss(page, '/supported-stores')
    })

    test('a store page', async ({ page }) => {
        const site = await firstLinkedStoreDomain(page)
        await expectStyledFromInlineCss(page, `/coupons/${site}`)
    })
})
