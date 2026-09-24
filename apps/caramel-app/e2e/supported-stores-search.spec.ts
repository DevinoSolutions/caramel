import { expect, test } from '@playwright/test'

// The /supported-stores search box's placeholder is a URL, so shoppers paste
// URLs into it. Before the search reduced its query to a store domain
// (storeSearchTerm), `https://www.<store>/…` matched nothing and a SUPPORTED
// store was answered with "We don’t support that store yet" and a Request
// Support button (PostHog, Aug-Sep 2026).
//
// Deployment-safe (runs in BOTH e2e contexts): the store is read from the
// page's own server-rendered "Top Supported Websites" grid, never assumed.

const STORE_LINK = /^\/coupons\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/

test.describe('Supported stores search', () => {
    test('a pasted product URL finds the store it belongs to', async ({
        page,
    }) => {
        await page.goto('/supported-stores')

        const hrefs = await page
            .locator('main a[href^="/coupons/"]')
            .evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''))
        const site = hrefs
            .map(href => STORE_LINK.exec(href)?.[1])
            .find(match => match !== undefined)
        expect(site, 'a supported store on the page to search for').toBeTruthy()

        await page
            .getByLabel('Search for a supported store')
            .fill(`https://www.${site}/some/product-page?ref=e2e#reviews`)

        await expect(
            page.locator(`main a[href="/coupons/${site}"]`).first(),
        ).toBeVisible({ timeout: 15000 })
        await expect(
            page.getByText(/We don’t support that store yet/),
        ).toHaveCount(0)
        await expect(
            page.getByRole('heading', { name: /Top Supported Websites/ }),
        ).toHaveCount(0)
    })

    test('a store we do not carry still offers the request form', async ({
        page,
    }) => {
        await page.goto('/supported-stores')
        await page
            .getByLabel('Search for a supported store')
            .fill('https://www.not-a-real-store-e2e-4821.com/cart')

        await expect(
            page.getByText(/We don’t support that store yet/),
        ).toBeVisible({ timeout: 15000 })
    })

    test('the legacy /supported-sites link lands on /supported-stores', async ({
        page,
    }) => {
        const res = await page.request.get('/supported-sites', {
            maxRedirects: 0,
        })
        expect(res.status()).toBe(308)
        expect(res.headers()['location']).toMatch(/\/supported-stores$/)

        await page.goto('/supported-sites')
        await expect(page).toHaveURL(/\/supported-stores$/)
    })
})
