import { expect, test } from '@playwright/test'

test.describe('SEO & Accessibility Basics', () => {
    test('home page has correct title', async ({ page }) => {
        await page.goto('/')
        await expect(page).toHaveTitle(/caramel/i)
    })

    test('home page has meta description', async ({ page }) => {
        await page.goto('/')
        const meta = page.locator('meta[name="description"]')
        await expect(meta).toHaveAttribute('content', /.+/)
    })

    test('login page has correct title', async ({ page }) => {
        await page.goto('/login')
        await expect(page).toHaveTitle(/login|caramel/i)
    })

    test('signup page has correct title', async ({ page }) => {
        await page.goto('/signup')
        await expect(page).toHaveTitle(/sign up|caramel/i)
    })

    test('privacy page has correct title', async ({ page }) => {
        await page.goto('/privacy')
        await expect(page).toHaveTitle(/privacy|caramel/i)
    })

    test('images have alt text', async ({ page }) => {
        await page.goto('/')

        const images = page.locator('img')
        const count = await images.count()

        for (let i = 0; i < Math.min(count, 10); i++) {
            const alt = await images.nth(i).getAttribute('alt')
            expect(
                alt !== null && alt !== undefined,
                `Image ${i} should have an alt attribute`,
            ).toBeTruthy()
        }
    })
})

// Crawler-view SEO gates for the coupon pages (2026-07-30). Every assertion
// below reads the RAW server response via page.request — never the hydrated
// DOM — because what ranks is what a crawler receives on first byte. This is
// the regression class that actually shipped: /coupons served a client-only
// loader shell (zero coupon content, zero h1) to crawlers.
//
// Two-context rule (docs/testing.md): these run against BOTH the hermetic
// seeded app (e2e-pr/local) and the deployed dev site (e2e-push). Only the
// codecademy.com assertion depends on a specific catalog row, so only it is
// DATABASE_URL-gated; everything else holds on any non-empty catalog.
function extractJsonLd(html: string): Array<Record<string, unknown>> {
    const scriptRe =
        /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    const blocks: Array<Record<string, unknown>> = []
    let match: RegExpExecArray | null
    while ((match = scriptRe.exec(html)) !== null) {
        blocks.push(JSON.parse(match[1]!) as Record<string, unknown>)
    }
    return blocks
}

test.describe('Coupon pages — crawler-visible SEO', () => {
    test('/coupons serves server-rendered coupon content, one h1, canonical and ItemList JSON-LD', async ({
        page,
    }) => {
        const res = await page.request.get('/coupons')
        expect(res.status()).toBe(200)
        const html = await res.text()

        // Real card content in the raw HTML — not a loading spinner. The
        // catalog is never legitimately empty in either context (see
        // pages.spec.ts's card test for the rationale).
        expect(html).toContain('Get Coupon Code')
        expect(html).not.toContain('Loading coupons...')

        expect((html.match(/<h1/g) ?? []).length).toBe(1)
        expect(html).toMatch(
            /<link rel="canonical" href="https:\/\/grabcaramel\.com\/coupons"\/?>/,
        )

        const itemList = extractJsonLd(html).find(
            d => d['@type'] === 'ItemList',
        )
        expect(itemList).toBeTruthy()
        expect(Number(itemList!.numberOfItems)).toBeGreaterThan(0)
    })

    test('store slug variants canonicalize to the ONE base-domain URL', async ({
        page,
    }) => {
        const res = await page.request.get('/coupons/www.codecademy.com')
        expect(res.status()).toBe(200)
        const html = await res.text()

        // www. variant must point at the base-domain canonical — otherwise
        // every slug spelling competes as its own duplicate page.
        expect(html).toMatch(
            /<link rel="canonical" href="[^"]*\/coupons\/codecademy\.com"\/?>/,
        )
    })

    test('a store page with zero coupons is noindexed (no soft-404 index bloat) but still followed', async ({
        page,
    }) => {
        // Made-up domain: has zero coupons in ANY catalog, hermetic or real.
        const res = await page.request.get(
            '/coupons/no-coupons-here-zz.example',
        )
        expect(res.status()).toBe(200)
        const html = await res.text()

        expect(html).toMatch(/name="robots"[^>]*content="[^"]*noindex/)
        expect(html).toMatch(/name="robots"[^>]*content="[^"]*follow/)
    })

    test('a store page with coupons is indexable and carries ItemList + BreadcrumbList (hermetic DB only)', async ({
        page,
    }) => {
        test.skip(
            !process.env.DATABASE_URL,
            'asserts the synthetic catalog_seed store — only guaranteed in the hermetic e2e-pr/local DB (docs/testing.md two-context rule)',
        )
        const res = await page.request.get('/coupons/codecademy.com')
        expect(res.status()).toBe(200)
        const html = await res.text()

        // Indexable: no noindex on a store that has codes.
        expect(html).not.toMatch(/name="robots"[^>]*noindex/)

        const jsonLd = extractJsonLd(html)
        const itemList = jsonLd.find(d => d['@type'] === 'ItemList')
        const breadcrumb = jsonLd.find(d => d['@type'] === 'BreadcrumbList')
        expect(itemList).toBeTruthy()
        expect(Number(itemList!.numberOfItems)).toBeGreaterThan(0)
        expect(breadcrumb).toBeTruthy()

        // Server-rendered internal links to other store pages (orphan-page
        // fix) — the popular-stores block must be in the raw HTML.
        expect(html).toContain('Popular coupon stores')
    })

    test('sitemap.xml and robots.txt are served', async ({ page }) => {
        const sitemap = await page.request.get('/sitemap.xml')
        expect(sitemap.status()).toBe(200)
        expect(await sitemap.text()).toContain('/coupons</loc>')

        const robots = await page.request.get('/robots.txt')
        expect(robots.status()).toBe(200)
    })
})

test.describe('Responsive - Mobile Viewport', () => {
    test.use({ viewport: { width: 375, height: 812 } })

    test('mobile menu toggle exists on home page', async ({ page }) => {
        await page.goto('/')

        // On mobile, there should be a hamburger menu button
        const menuButton = page.getByRole('banner').getByRole('button').first()
        await expect(menuButton).toBeVisible()
    })

    test('login page is usable on mobile', async ({ page }) => {
        await page.goto('/login')

        await expect(page.getByPlaceholder('Enter your email')).toBeVisible()
        await expect(page.getByPlaceholder('Enter your password')).toBeVisible()
        await expect(page.getByRole('button', { name: /login/i })).toBeVisible()
    })
})
