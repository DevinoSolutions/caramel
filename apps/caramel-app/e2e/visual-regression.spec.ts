import { argosScreenshot } from '@argos-ci/playwright'
import { Page, test } from '@playwright/test'

test.describe.configure({ timeout: 60000 })

// Scroll through the page to trigger Framer Motion whileInView animations.
// Argos handles font/image loading and animation stabilization natively,
// but can't trigger scroll-dependent state changes.
async function triggerInViewAnimations(page: Page) {
    await page.evaluate(async () => {
        // Yield animation frames instead of sleeping — wall-clock sleeps
        // (setTimeout / new Promise(setTimeout)) are banned in e2e specs
        // (tests/unit/test-quality-guardrails.test.ts). The instant
        // `behavior: 'auto'` scrolls have no scroll animation to wait out; the
        // frame yields exist only so IntersectionObserver fires each section's
        // Framer Motion whileInView before capture. IO callbacks dispatch
        // within a frame of the scroll, and Argos freezes animations
        // (`animations: 'disabled'`) at screenshot time — so a few frames per
        // step deterministically reaches the final triggered state, with no
        // guessed millisecond budget. (The frame wait is inlined, not a
        // helper: it must run in this browser page.evaluate context.)
        const step = Math.max(Math.floor(window.innerHeight * 0.8), 1)
        const maxScroll = Math.max(
            document.documentElement.scrollHeight - window.innerHeight,
            0,
        )

        for (let position = 0; position <= maxScroll; position += step) {
            window.scrollTo({ top: position, behavior: 'auto' })
            for (let frame = 0; frame < 6; frame += 1) {
                await new Promise<void>(resolve =>
                    requestAnimationFrame(() => resolve()),
                )
            }
        }

        window.scrollTo({ top: maxScroll, behavior: 'auto' })
        for (let frame = 0; frame < 10; frame += 1) {
            await new Promise<void>(resolve =>
                requestAnimationFrame(() => resolve()),
            )
        }
        window.scrollTo({ top: 0, behavior: 'auto' })
    })
}

async function prepareVisualPage(
    page: Page,
    path: string,
    readySelector?: string,
) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })

    // Wait for hydration before touching the page. Public pages server-render
    // now, and argosScreenshot rewrites img loading/decoding attributes and
    // stamps data-argos-* nodes; doing that while React is still hydrating
    // makes React report attribute mismatches ("won't be patched up") into the
    // dev-server log. data-hydrated is set from the Providers mount effect,
    // i.e. strictly after the hydrated tree commits — see src/app/providers.tsx.
    await page.locator('html[data-hydrated="true"]').waitFor()

    if (readySelector) {
        await page.locator(readySelector).first().waitFor({ state: 'visible' })
    }

    await triggerInViewAnimations(page)
}

test.describe('Visual Regression - Caramel Public Pages', () => {
    test('home page', async ({ page }) => {
        await prepareVisualPage(page, '/', '#features')
        await argosScreenshot(page, 'home-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('privacy page', async ({ page }) => {
        await prepareVisualPage(page, '/privacy', 'main')
        await argosScreenshot(page, 'privacy-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('supported stores page', async ({ page }) => {
        await prepareVisualPage(page, '/supported-stores', 'input')
        await argosScreenshot(page, 'supported-stores-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('pricing page', async ({ page }) => {
        await prepareVisualPage(page, '/pricing', 'main')
        await argosScreenshot(page, 'pricing-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('coupons page', async ({ page }) => {
        await prepareVisualPage(page, '/coupons', 'main')
        await argosScreenshot(page, 'coupons-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('login page', async ({ page }) => {
        await prepareVisualPage(page, '/login', 'form')
        await argosScreenshot(page, 'login-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('signup page', async ({ page }) => {
        await prepareVisualPage(page, '/signup', 'form')
        await argosScreenshot(page, 'signup-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })

    test('sources page', async ({ page }) => {
        await prepareVisualPage(page, '/sources', 'table')
        await argosScreenshot(page, 'sources-page', {
            animations: 'disabled',
            fullPage: true,
        })
    })
})
