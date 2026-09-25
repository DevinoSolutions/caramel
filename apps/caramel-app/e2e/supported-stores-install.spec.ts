import { devices, expect, test, type Page } from '@playwright/test'

// /supported-stores was the second-biggest landing page and had no
// browser-store link: 5 of 175 landing sessions ever reached a browser store, against
// 621 of 1,310 for the homepage (PostHog, 30 days to 2026-09-25). These pin
// the install step that now sits under the search box.
//
// Nothing is mocked: the real page, the real user-agent detection and the real
// extension stamp the Caramel extension writes onto <html>. No database reads
// are asserted and nothing is written, so this runs in both e2e contexts.

const calloutLink = (page: Page) =>
    page
        .locator('[data-growth="install"]')
        .filter({ hasText: 'Found your store?' })
        .getByRole('link')

test.describe('Supported stores install step', () => {
    test('desktop Chrome gets an Add to Chrome link above the fold', async ({
        page,
    }) => {
        await page.goto('/supported-stores')

        const link = calloutLink(page)
        await expect(link).toHaveText('Add to Chrome')
        await expect(link).toHaveAttribute(
            'href',
            /^https:\/\/chromewebstore\.google\.com\/detail\//,
        )
        await expect(link).toHaveAttribute('target', '_blank')

        // Above the fold is the point: the shopper answering "is my store
        // supported?" must not have to scroll to find the next step.
        const box = await link.boundingBox()
        const viewport = page.viewportSize()
        expect(box, 'the install link is laid out').not.toBeNull()
        expect(viewport).not.toBeNull()
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
    })

    test('the step disappears once the extension stamps the page', async ({
        page,
    }) => {
        await page.goto('/supported-stores')
        await expect(calloutLink(page)).toBeVisible()

        // Exactly what an installed extension does on grabcaramel.com.
        await page.evaluate(() =>
            document.documentElement.setAttribute(
                'data-caramel-extension',
                'e2e',
            ),
        )
        // Count 0, not just hidden: globals.css also hides
        // [data-growth="install"] under the stamp, so toBeHidden() alone
        // would pass even if InstallSurfaceGate never unmounted the callout.
        await expect(calloutLink(page)).toHaveCount(0)
    })
})

test.describe('Supported stores install step on a phone', () => {
    // No store sells a phone an extension it can install (Android Chrome has
    // none; the Safari build is a Mac app), so a phone is sent to /apps.
    // The device preset minus `defaultBrowserType`, which cannot be set per
    // describe block; the phone is identified by its user agent and touch.
    const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } =
        devices['iPhone 13']
    test.use({ userAgent, viewport, deviceScaleFactor, isMobile, hasTouch })

    test('an iPhone is sent to /apps instead of a store listing', async ({
        page,
    }) => {
        await page.goto('/supported-stores')
        // The server HTML already says "Get Caramel" (the browser is unknown
        // before hydration), so wait until the page has actually detected an
        // iPhone — otherwise this would only test the server render.
        await expect(page.locator('[data-surface="web"]')).toHaveCount(1)

        const link = calloutLink(page)
        await expect(link).toHaveText('Get Caramel')
        await link.click()
        await expect(page).toHaveURL(/\/apps$/)
    })
})
