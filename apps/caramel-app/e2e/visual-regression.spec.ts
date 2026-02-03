import { argosScreenshot } from '@argos-ci/playwright'
import { test } from '@playwright/test'

test.describe('Visual Regression - Caramel Public Pages', () => {
    test('home page screenshot', async ({ page }) => {
        await page.goto('/')
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(1000) // Let animations settle
        await argosScreenshot(page, 'home-page')
    })

    test('privacy page screenshot', async ({ page }) => {
        await page.goto('/privacy')
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(500)
        await argosScreenshot(page, 'privacy-page')
    })

    test('supported stores page screenshot', async ({ page }) => {
        await page.goto('/supported-stores')
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(500)
        await argosScreenshot(page, 'supported-stores-page')
    })
})
