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
    // A page that never hydrates (T-9427: a prod deploy swapped containers
    // mid-run, so its HTML and JS chunks came from different builds) can only
    // time out here; e2e-push reruns the suite when the served sha changed
    // during the run (run-e2e-push.sh), so this wait stays strict.
    await page.locator('html[data-hydrated="true"]').waitFor()

    if (readySelector) {
        await page.locator(readySelector).first().waitFor({ state: 'visible' })
    }

    // Freeze CSS animations and transitions so a screenshot never lands on a
    // mid-transition frame. This cannot stop framer-motion: its JS/WAAPI
    // animations are not CSS. Those are handled by <MotionConfig
    // reducedMotion="user"> under the reduced-motion emulation (transforms are
    // skipped, opacity still fades); triggerInViewAnimations and Argos's
    // `animations: 'disabled'` settle those fades before capture.
    await page.addStyleTag({
        content:
            '*,*::before,*::after{animation:none!important;transition:none!important}',
    })

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
