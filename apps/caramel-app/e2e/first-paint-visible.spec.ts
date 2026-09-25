import { expect, test, type Locator, type Page } from '@playwright/test'

// The text a visitor lands on must be visible in the server HTML itself.
//
// A framer-motion entrance (`initial={{ opacity: 0 }}`) is serialised into the
// server HTML as style="opacity:0", so the element cannot paint until the
// whole bundle has downloaded and hydrated. On store pages and
// /supported-stores that made the heading, the intro and every coupon card
// invisible for seconds on a phone: Lighthouse mobile measured LCP at 4.7 s
// (store page) and 8.6 s (/supported-stores), almost all of it "render delay"
// (2026-09-25). The homepage hero was fixed the same way earlier (see the
// .hero-enter note in globals.css).
//
// JavaScript is OFF here, which is exactly what the page looks like before
// hydration. Playwright's toBeVisible() counts opacity:0 as visible, so this
// multiplies the computed opacity up the ancestor chain instead.
//
// Deployment-safe: the store is read from the page's own server-rendered
// links, never assumed, and nothing is written.

test.use({ javaScriptEnabled: false })

async function effectiveOpacity(locator: Locator): Promise<number> {
    return locator.evaluate(el => {
        let opacity = 1
        for (let node: Element | null = el; node; node = node.parentElement) {
            opacity *= Number(getComputedStyle(node).opacity)
        }
        return opacity
    })
}

async function expectPaintedWithoutJs(locator: Locator, what: string) {
    await expect(locator, what).toHaveCount(1)
    expect(await effectiveOpacity(locator), `${what} opacity`).toBe(1)
}

const STORE_LINK = /^\/coupons\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/

async function firstStoreWithCoupons(page: Page): Promise<string> {
    await page.goto('/supported-stores')
    const hrefs = await page
        .locator('main a[href^="/coupons/"]')
        .evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''))
    const site = hrefs
        .map(href => STORE_LINK.exec(href)?.[1])
        .find(match => match !== undefined)
    expect(
        site,
        'a store with coupons linked from /supported-stores',
    ).toBeTruthy()
    return site as string
}

test.describe('Above-the-fold content paints before any JavaScript runs', () => {
    test('/supported-stores: the heading and the first store card', async ({
        page,
    }) => {
        await page.goto('/supported-stores')
        await expectPaintedWithoutJs(
            page.getByRole('heading', {
                level: 1,
                name: 'Is your favourite store supported?',
            }),
            'the h1',
        )
        await expectPaintedWithoutJs(
            page.locator('main h3').first(),
            'the first store card',
        )
    })

    test('a store page: the heading, the intro and the first coupon', async ({
        page,
    }) => {
        const site = await firstStoreWithCoupons(page)
        await page.goto(`/coupons/${site}`)

        await expectPaintedWithoutJs(
            page.getByRole('heading', { level: 1 }),
            'the h1',
        )
        await expectPaintedWithoutJs(
            page.locator('main h1 + p'),
            'the intro paragraph',
        )
        // Each coupon card's title is an h3; the first one is above the fold.
        await expectPaintedWithoutJs(
            page.locator('main h3').first(),
            'the first coupon card',
        )
    })
})
