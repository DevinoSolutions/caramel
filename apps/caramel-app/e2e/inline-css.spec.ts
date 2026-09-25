import { expect, test, type Page } from '@playwright/test'

// The stylesheet ships inside the HTML, so a first visit paints without
// waiting on a second round trip.
//
// Lighthouse mobile with applied throttling (2026-09-25, a store page): the
// HTML had fully arrived at 252 ms, but the page's one render-blocking
// stylesheet was requested at 51 ms and only started arriving at 645 ms, so
// nothing (the hero text included) painted until ~980 ms. next.config.mjs now
// sets experimental.inlineCss, which puts the CSS in a <style> in the <head>.
//
// Production builds only: `next dev` always uses <link> tags. The hermetic
// lane (DATABASE_URL set) runs `next dev`, so this spec skips there, and the
// compose-build CI job asserts the same thing on a real production build
// instead. It runs against every deployed build (e2e-push, prod).
//
// JavaScript is off: this is the page a browser can paint before hydration.

test.use({ javaScriptEnabled: false })

test.skip(
    !!process.env.DATABASE_URL,
    'hermetic lane serves `next dev`, which never inlines CSS (covered by the compose-build CI job)',
)

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

const STORE_LINK = /^\/coupons\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/

test.describe('CSS is inlined into the HTML', () => {
    test('/supported-stores', async ({ page }) => {
        await expectStyledFromInlineCss(page, '/supported-stores')
    })

    test('a store page', async ({ page }) => {
        await page.goto('/supported-stores')
        const hrefs = await page
            .locator('main a[href^="/coupons/"]')
            .evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''))
        const site = hrefs
            .map(href => STORE_LINK.exec(href)?.[1])
            .find(match => match !== undefined)
        if (!site) {
            throw new Error('no store linked from /supported-stores')
        }
        await expectStyledFromInlineCss(page, `/coupons/${site}`)
    })
})
