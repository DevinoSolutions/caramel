import { expect, Page, test } from '@playwright/test'

async function gotoHomePage(page: Page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(
        page.getByRole('heading', { name: /welcome to/i }).first(),
    ).toBeVisible()
}

test.describe('Home Page - Critical Sections', () => {
    test.describe.configure({ timeout: 60000 })

    test.beforeEach(async ({ page }) => {
        await gotoHomePage(page)
    })

    test('hero section loads with CTA buttons', async ({ page }) => {
        // exact: the hero splits its heading into a "Welcome to" line + the
        // logo image, so match that exact standalone line.
        await expect(
            page.getByText('Welcome to', { exact: true }),
        ).toBeVisible()

        const installBtn = page.getByRole('link', {
            name: /install extension/i,
        })
        await expect(installBtn).toBeVisible()

        const sourceBtn = page.getByRole('link', {
            name: /view source code/i,
        })
        await expect(sourceBtn).toBeVisible()
        await expect(sourceBtn).toHaveAttribute(
            'href',
            /github\.com\/DevinoSolutions\/caramel/,
        )
    })

    test('features section is present', async ({ page }) => {
        const section = page.getByText('Why Choose Caramel?')
        await expect(section.first()).toBeVisible()
    })

    test('feature cards render', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: 'Automated Coupon Application' }),
        ).toBeVisible()
        await expect(
            page.getByRole('heading', { name: 'Privacy-First & Transparent' }),
        ).toBeVisible()
        await expect(
            page.getByRole('heading', { name: '100% Open Source' }).first(),
        ).toBeVisible()
        await expect(
            page.getByRole('heading', { name: 'Creator-Friendly' }),
        ).toBeVisible()
        await expect(
            page.getByRole('heading', { name: 'Lightning Fast' }),
        ).toBeVisible()
        await expect(
            page.getByRole('heading', { name: 'Cross-Browser Support' }),
        ).toBeVisible()
    })

    test('browser install links are present', async ({ page }) => {
        const installSection = page.locator('#install-extension')
        await installSection.scrollIntoViewIfNeeded()

        const chromeLink = installSection.getByRole('link', {
            name: /chrome/i,
        })
        await expect(chromeLink).toBeVisible()
        await expect(chromeLink).toHaveAttribute(
            'href',
            /chromewebstore\.google\.com/,
        )

        const firefoxLink = installSection.getByRole('link', {
            name: /firefox/i,
        })
        await expect(firefoxLink).toBeVisible()
        await expect(firefoxLink).toHaveAttribute(
            'href',
            /addons\.mozilla\.org/,
        )

        const safariLink = installSection.getByRole('link', {
            name: /safari/i,
        })
        await expect(safariLink).toBeVisible()
        await expect(safariLink).toHaveAttribute('href', /apps\.apple\.com/)

        const edgeLink = installSection.getByRole('link', { name: /edge/i })
        await expect(edgeLink).toBeVisible()
        await expect(edgeLink).toHaveAttribute(
            'href',
            /microsoftedge\.microsoft\.com/,
        )
    })

    test('comparison section shows Caramel vs Others', async ({ page }) => {
        const comparison = page.getByRole('heading', {
            name: 'Caramel vs Others',
        })
        await comparison.scrollIntoViewIfNeeded()
        await expect(comparison).toBeVisible()

        // Assert on the comparison cells that actually render (the row
        // titles are data-only keys) — copy updated in the claim-integrity
        // sweep, keep in sync with FeaturesSection's comparisonItems.
        await expect(page.getByText('Opaque data practices')).toBeVisible()
        await expect(
            page.getByText('No ad tracking or data selling'),
        ).toBeVisible()
    })

    test('Honey vs Caramel named comparison renders both columns', async ({
        page,
    }) => {
        const heading = page.getByRole('heading', {
            name: 'Honey vs Caramel',
        })
        await heading.scrollIntoViewIfNeeded()
        await expect(heading).toBeVisible()

        // One documented Honey-side claim and its paired Caramel-side answer.
        await expect(page.getByText('Affiliate Link Hijacking')).toBeVisible()
        await expect(page.getByText('Respects Creator Links')).toBeVisible()
        // The re-scoped privacy claim (never "zero data collection").
        await expect(page.getByText('No Data Selling')).toBeVisible()
    })

    test('FAQ section renders visible answers and matching FAQPage JSON-LD', async ({
        page,
    }) => {
        const faq = page.locator('#faq')
        await faq.scrollIntoViewIfNeeded()
        await expect(
            page.getByRole('heading', { name: 'Frequently Asked Questions' }),
        ).toBeVisible()
        await expect(
            faq.getByText(
                'Does Caramel replace or hijack creator affiliate links?',
            ),
        ).toBeVisible()

        // The FAQPage + Organization/SoftwareApplication entity markup is
        // server-rendered on the landing page (deployment-safe: no DB).
        const jsonLdBlocks = await page
            .locator('script[type="application/ld+json"]')
            .allTextContents()
        expect(jsonLdBlocks.some(t => t.includes('"FAQPage"'))).toBe(true)
        expect(
            jsonLdBlocks.some(t => t.includes('"SoftwareApplication"')),
        ).toBe(true)
        // Claim-integrity rule: no invented social proof, ever.
        expect(jsonLdBlocks.some(t => /aggregateRating/i.test(t))).toBe(false)
    })
})
