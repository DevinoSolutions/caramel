import { expect, test } from '@playwright/test'
// The app's own slug→registrable-domain rule (tldts / Public Suffix List).
// Relative import on purpose: e2e collection runs in BOTH contexts (hermetic
// and deployed, no generated prisma client) and this module is pure — no
// `@/` alias, no prisma, no env.
import { resolveStoreDomain } from '../src/lib/storeDomain'

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
// Distinct hrefs matching `re` (group 1) in raw HTML, in document order.
function hrefsOf(html: string, re: RegExp): string[] {
    return Array.from(new Set(Array.from(html.matchAll(re)).map(m => m[1]!)))
}

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

    // Sitemap ↔ canonical agreement (GSC audit 2026-09-11: 84 subdomain slugs,
    // 2 mixed-case slugs and 1 non-domain were listed whose own page
    // canonicalized elsewhere, and 4,289 of 4,317 sitemap URLs were unknown to
    // Google). Every store <loc> must BE the canonical the page emits — i.e.
    // its own resolveStoreDomain, lowercase — and nothing may repeat. Holds
    // on any non-empty catalog, so it stays ungated (two-context rule).
    test('every store <loc> in sitemap.xml is its own canonical base (lowercase, PSL-resolved) and no <loc> repeats', async ({
        page,
    }) => {
        const res = await page.request.get('/sitemap.xml')
        expect(res.status()).toBe(200)
        const xml = await res.text()

        const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
            m => m[1]!,
        )
        expect(locs.length).toBeGreaterThan(0)
        expect(new Set(locs).size, 'duplicate <loc> in sitemap.xml').toBe(
            locs.length,
        )

        const storeSlugs = locs
            .map(loc => /\/coupons\/([^/?#]+)$/.exec(loc)?.[1])
            .filter((slug): slug is string => Boolean(slug))
            .map(slug => decodeURIComponent(slug))
            // /coupons/stores is the A–Z directory index, not a store page.
            .filter(slug => slug !== 'stores')
        // The catalog is never legitimately empty in either context.
        expect(storeSlugs.length).toBeGreaterThan(0)

        const offenders = storeSlugs.filter(
            slug =>
                slug !== slug.toLowerCase() ||
                resolveStoreDomain(slug) !== slug,
        )
        expect(
            offenders,
            `store <loc>s that are not their own canonical base: ${offenders.slice(0, 20).join(', ')}`,
        ).toEqual([])
    })

    test('/support is listed in sitemap.xml', async ({ baseURL, page }) => {
        const res = await page.request.get('/sitemap.xml')
        expect(res.status()).toBe(200)
        const origin = (baseURL ?? '').replace(/\/+$/, '')
        expect(await res.text()).toContain(`<loc>${origin}/support</loc>`)
    })

    // A–Z store directory (2026-09-12): before it, 8 of ~4,262 store pages
    // had any internal inbound link — the rest were sitemap-only orphans.
    // These walk the crawl chain the way a crawler does, from the RAW HTML:
    // directory index → a letter page → a store page → its neighbours. URLs
    // are discovered from the served HTML, never assumed, so the tests hold
    // against the 5-store hermetic seed and the real catalog alike.
    const letterHrefRe = /href="(\/coupons\/stores\/(?:[a-z]|0-9))"/g
    const storeHrefRe = /href="(\/coupons\/(?!stores(?:\/|"|$))[^"/?#]+)"/g

    test('/coupons/stores is served with a self canonical, index+follow, and at least one letter link', async ({
        page,
    }) => {
        const res = await page.request.get('/coupons/stores')
        expect(res.status()).toBe(200)
        const html = await res.text()

        expect(html).toMatch(
            /<link rel="canonical" href="[^"]*\/coupons\/stores"\/?>/,
        )
        expect(html).not.toMatch(/name="robots"[^>]*noindex/)
        expect((html.match(/<h1/g) ?? []).length).toBe(1)
        expect(hrefsOf(html, letterHrefRe).length).toBeGreaterThan(0)
    })

    test('a letter page found from the directory index is served with a self canonical and lists store links', async ({
        page,
    }) => {
        const index = await page.request.get('/coupons/stores')
        const letterPath = hrefsOf(await index.text(), letterHrefRe)[0]
        expect(letterPath).toBeTruthy()

        const res = await page.request.get(letterPath!)
        expect(res.status()).toBe(200)
        const html = await res.text()

        expect(html).toMatch(
            new RegExp(
                `<link rel="canonical" href="[^"]*${letterPath!.replace(/[/-]/g, '\\$&')}"/?>`,
            ),
        )
        expect(html).not.toMatch(/name="robots"[^>]*noindex/)
        const storeHrefs = hrefsOf(html, storeHrefRe)
        expect(storeHrefs.length).toBeGreaterThan(0)
        // Every listed store is a canonical base (the same rule the sitemap
        // obeys) and shows a real code count.
        for (const href of storeHrefs) {
            const slug = decodeURIComponent(href.slice('/coupons/'.length))
            expect(resolveStoreDomain(slug), href).toBe(slug)
        }
        expect(html).toMatch(/ · \d[\d,]* codes?</)
    })

    test('a store page reached from a letter page carries a "More stores" section with at least one neighbour link', async ({
        page,
    }) => {
        const index = await page.request.get('/coupons/stores')
        const letterPath = hrefsOf(await index.text(), letterHrefRe)[0]!
        const letter = await page.request.get(letterPath)
        const storePath = hrefsOf(await letter.text(), storeHrefRe)[0]
        expect(storePath).toBeTruthy()

        const res = await page.request.get(storePath!)
        expect(res.status()).toBe(200)
        const html = await res.text()

        expect(html).toContain('More stores')
        // At least one OTHER store linked from this page (the neighbour chain),
        // and the way back into the directory letter this store lives on.
        const others = hrefsOf(html, storeHrefRe).filter(h => h !== storePath)
        expect(others.length).toBeGreaterThan(0)
        expect(hrefsOf(html, letterHrefRe)).toContain(letterPath)
    })

    test('a letter with no stores is a 404, not an empty page', async ({
        page,
    }) => {
        // Not a directory letter at all — always 404 regardless of catalog.
        const res = await page.request.get('/coupons/stores/zz')
        expect(res.status()).toBe(404)
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

        await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
        await expect(page.getByPlaceholder('Enter your password')).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Sign in', exact: true }),
        ).toBeVisible()

        // The desktop brand panel is removed below 1024px, so the compact
        // header is what tells a phone visitor whose sign-in page this is.
        await expect(
            page.getByRole('link', { name: /back to home/i }),
        ).toBeVisible()
    })
})
