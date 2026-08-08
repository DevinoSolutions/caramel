import { expect, Page, test } from '@playwright/test'

async function gotoHomePage(page: Page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('header')).toBeVisible()
}

test.describe('Navigation & Header', () => {
    test.describe.configure({ timeout: 60000 })

    test('header renders with all nav links', async ({ page }) => {
        await gotoHomePage(page)

        const nav = page.locator('header')
        await expect(nav).toBeVisible()

        await expect(nav.getByRole('link', { name: /home/i })).toBeVisible()
        await expect(nav.getByRole('link', { name: /coupons/i })).toBeVisible()
        await expect(nav.getByRole('link', { name: /pricing/i })).toBeVisible()
        await expect(nav.getByRole('link', { name: /privacy/i })).toBeVisible()
        await expect(
            nav.getByRole('link', { name: /supported stores/i }),
        ).toBeVisible()
    })

    test('header shows login and signup when logged out', async ({ page }) => {
        await gotoHomePage(page)

        const header = page.locator('header')
        await expect(header.getByRole('link', { name: /login/i })).toBeVisible()
        await expect(
            header.getByRole('link', { name: /sign up/i }),
        ).toBeVisible()
    })

    // The URL asserts below use 15s (default 5s): the click lands right after
    // domcontentloaded on a cold 2-core CI runner, where the app-router commit
    // races first-hit page-module loading + hydration of the home bundle. The
    // assert still proves navigation happens; it just tolerates cold latency.
    test('can navigate to coupons page', async ({ page }) => {
        await gotoHomePage(page)

        await page
            .locator('header')
            .getByRole('link', { name: /coupons/i })
            .click()
        await expect(page).toHaveURL(/\/coupons/, { timeout: 15000 })
    })

    test('can navigate to pricing page', async ({ page }) => {
        await gotoHomePage(page)

        await page
            .locator('header')
            .getByRole('link', { name: /pricing/i })
            .click()
        await expect(page).toHaveURL(/\/pricing/, { timeout: 15000 })
    })

    test('can navigate to privacy page', async ({ page }) => {
        await gotoHomePage(page)

        await page
            .locator('header')
            .getByRole('link', { name: /privacy/i })
            .click()
        await expect(page).toHaveURL(/\/privacy/, { timeout: 15000 })
    })

    test('can navigate to supported stores page', async ({ page }) => {
        await gotoHomePage(page)

        await page
            .locator('header')
            .getByRole('link', { name: /supported stores/i })
            .click()
        await expect(page).toHaveURL(/\/supported-stores/, { timeout: 15000 })
    })
})
