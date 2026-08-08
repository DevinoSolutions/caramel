import { expect, test } from '@playwright/test'

test.describe('Coupons Page', () => {
    test('coupons page loads with content', async ({ page }) => {
        await page.goto('/coupons')

        await expect(
            page.getByRole('heading', {
                level: 1,
                name: /verified coupon codes/i,
            }),
        ).toBeVisible()
        await expect(page.getByText(/browse.*coupon/i).first()).toBeVisible()
    })

    // Deployment-safe (runs in BOTH e2e contexts — docs/testing.md "E2E runs
    // in TWO contexts"): the /coupons client fetch → /api/coupons read path →
    // CouponCard render, proven by a GENERIC card landmark. No catalog is
    // ever legitimately empty here — hermetic e2e-pr/local is seeded by the
    // catalog_seed migration, and the deployed dev site serves the real
    // ingested catalog — so at least one card with its CTA must render.
    test('renders at least one coupon card from the catalog', async ({
        page,
    }) => {
        await page.goto('/coupons')

        // Client-side fetch + render, so allow generous time for the first page.
        await expect(
            page.getByRole('button', { name: /get coupon code/i }).first(),
        ).toBeVisible({ timeout: 15000 })
    })

    // HERMETIC-ONLY (gated like auth-flows' "Login (real session)" group —
    // docs/testing.md two-context rule): asserts a SPECIFIC synthetic seed row,
    // which only exists in the fresh-seeded e2e-pr/local DB. On the deployed
    // dev site (e2e-push, no DATABASE_URL) the catalog is REAL ingested data:
    // real rows outrank the anchor's 4.9 rating and a full-catalog ingest
    // tombstones the synthetic rows — asserting it there failed 3/3, hence the
    // gate. Anchor: the highest-rated (4.9) synthetic coupon "40% off Pro
    // annual" (codecademy.com, LEARN40), which ORDER BY rating DESC,
    // created_at DESC guarantees on the first page of a freshly seeded DB —
    // see prisma/migrations/20260714220157_catalog_seed/migration.sql
    // (SYNTHETIC, never the real scraped catalog).
    test('renders the synthetic seed anchor coupon (hermetic DB only)', async ({
        page,
    }) => {
        test.skip(
            !process.env.DATABASE_URL,
            'asserts a synthetic catalog_seed row — only present in the hermetic e2e-pr/local DB (docs/testing.md two-context rule)',
        )
        await page.goto('/coupons')

        await expect(page.getByText('40% off Pro annual').first()).toBeVisible({
            timeout: 15000,
        })
    })

    test('sidebar has browser install links', async ({ page }) => {
        await page.goto('/coupons')

        const chromeLink = page.getByRole('link', { name: /chrome/i })
        await expect(chromeLink.first()).toBeVisible()
    })

    test('sidebar links to supported stores', async ({ page }) => {
        await page.goto('/coupons')

        const supportedLink = page.getByRole('link', {
            name: /view all supported stores/i,
        })
        await expect(supportedLink).toBeVisible()
        await expect(supportedLink).toHaveAttribute('href', /supported-stores/)
    })
})

test.describe('Pricing Page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/pricing')
        await expect(
            page.getByText('Simple, Transparent Pricing').first(),
        ).toBeVisible()
    })

    test('shows free pricing', async ({ page }) => {
        await expect(
            page.getByText('Simple, Transparent Pricing').first(),
        ).toBeVisible()
        await expect(page.getByText('$0').first()).toBeVisible()
        await expect(page.getByText('Forever').first()).toBeVisible()
    })

    test('pricing card shows features', async ({ page }) => {
        await expect(page.getByText('ALWAYS FREE').first()).toBeVisible()
        await expect(page.getByText('Free Forever Plan').first()).toBeVisible()
        await expect(
            page.getByText('No credit card required').first(),
        ).toBeVisible()
        await expect(
            page.getByText('No hidden fees ever').first(),
        ).toBeVisible()
    })

    test('CTA button links to GitHub', async ({ page }) => {
        const cta = page.getByRole('link', {
            name: /get started.*free/i,
        })
        await expect(cta).toBeVisible()
        await expect(cta).toHaveAttribute(
            'href',
            /github\.com\/DevinoSolutions\/caramel/,
        )
    })
})

test.describe('Privacy Page', () => {
    test('privacy page renders content', async ({ page }) => {
        await page.goto('/privacy')

        await expect(page.getByText(/privacy/i).first()).toBeVisible()
    })
})

test.describe('Supported Stores Page', () => {
    test('supported stores page loads', async ({ page }) => {
        await page.goto('/supported-stores')

        // The page should have a search or list of stores
        await expect(page.locator('body')).toContainText(/supported|stores/i)
    })

    // Deployment-safe SSR/SEO gate (both e2e contexts — docs/testing.md
    // two-context rule): fetch the RAW server HTML, no JS execution, exactly
    // what a crawler gets. Before the SSR change the "Top Supported Websites"
    // grid only appeared after a client fetch of /api/sites/top-sites, so the
    // crawler HTML had no store content at all. The catalog is never
    // legitimately empty in either context (see the coupon-card test above),
    // so the top-sites heading must be present in the initial HTML.
    test('server HTML contains the top supported websites (crawler view)', async ({
        page,
    }) => {
        const res = await page.request.get('/supported-stores')
        expect(res.ok()).toBe(true)
        const html = await res.text()
        expect(html).toContain('Is your favourite store supported?')
        expect(html).toContain('Top Supported Websites')
    })
})

test.describe('Sources Page', () => {
    test('sources page loads with content', async ({ page }) => {
        await page.goto('/sources')

        // The page should show coupon source information
        await expect(page.locator('body')).toContainText(/source/i)
    })

    // Deployment-safe SSR/SEO gate (both e2e contexts): raw server HTML must
    // carry the sources table already resolved — the pre-SSR page served a
    // "Loading..." placeholder row and fetched /api/sources client-side, so
    // crawlers saw no data. "Loading..." only renders while a client refetch
    // is in flight, never in the server HTML anymore.
    test('server HTML contains the sources table (crawler view)', async ({
        page,
    }) => {
        const res = await page.request.get('/sources')
        expect(res.ok()).toBe(true)
        const html = await res.text()
        expect(html).toContain('Caramel coupon sources')
        expect(html).not.toContain('Loading...')
    })

    // HERMETIC-ONLY (docs/testing.md two-context rule): asserts the SPECIFIC
    // synthetic seed sources, which only exist in the fresh-seeded e2e-pr/
    // local DB — the deployed dev site serves real pipeline sources instead.
    // See prisma/migrations/20260714220157_catalog_seed/migration.sql.
    test('server HTML renders the synthetic seed sources (hermetic DB only)', async ({
        page,
    }) => {
        test.skip(
            !process.env.DATABASE_URL,
            'asserts synthetic catalog_seed sources rows — only present in the hermetic e2e-pr/local DB (docs/testing.md two-context rule)',
        )
        const res = await page.request.get('/sources')
        const html = await res.text()
        expect(html).toContain('Caramel Sample Feed A')
        expect(html).toContain('Caramel Sample Feed B')
    })
})
