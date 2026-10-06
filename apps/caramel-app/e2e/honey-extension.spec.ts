import { expect, test, type Page } from '@playwright/test'

// /honey-extension answers the generic Honey queries ("honey extension",
// "honey coupons", "honey chrome extension") that Search Console showed
// landing on the home page at page-two positions (28 days to 2026-10-02).
// These pin what a crawler and an answer engine get from it, and that the
// site's own links lead there.
//
// Nothing is mocked: the real server HTML, the real JSON-LD, the real
// user-agent detection. The page has no catalog read and nothing is written,
// so every test runs ungated in both e2e contexts.

const PATH = '/honey-extension'

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

const linkCount = (html: string, href: string) =>
    html.split(`href="${href}"`).length - 1

const calloutLink = (page: Page) =>
    page
        .locator('[data-growth="install"]')
        .filter({ hasText: 'Want one with no affiliate code?' })
        .getByRole('link')

test.describe('The Honey extension guide', () => {
    test('answers in the server HTML: one h1, self canonical, indexable, FAQPage markup matching the visible questions', async ({
        page,
    }) => {
        // ONE navigation: raw HTML and DOM from the same response.
        const res = await page.goto(PATH)
        expect(res?.status()).toBe(200)
        const html = await res!.text()

        await expect(page).toHaveTitle(/^Honey Extension in \d{4}: /)
        expect(html).toMatch(
            /<link rel="canonical" href="https?:\/\/[^"]+\/honey-extension"/,
        )
        expect(html).not.toMatch(/<meta name="robots" content="[^"]*noindex/)
        await expect(page.locator('h1')).toHaveCount(1)
        await expect(page.locator('h1')).toContainText('Honey extension')

        // The side-by-side table and the sources are server-rendered.
        expect(html).toContain('id="honey-vs-caramel-heading"')
        expect(html).toContain('id="source-1"')
        await expect(
            page.locator('thead th[scope="col"]').filter({ hasText: 'Honey' }),
        ).toHaveCount(1)

        const faq = extractJsonLd(html).find(d => d['@type'] === 'FAQPage') as
            | {
                  mainEntity: Array<{
                      name: string
                      acceptedAnswer: { text: string }
                  }>
              }
            | undefined
        expect(faq, 'FAQPage JSON-LD').toBeTruthy()
        expect(faq!.mainEntity.length).toBeGreaterThanOrEqual(5)
        const section = page.locator(
            'section[aria-labelledby="honey-faq-heading"]',
        )
        await expect(section.locator('h3')).toHaveText(
            faq!.mainEntity.map(q => q.name),
        )
        await expect(section.locator('h3 + p')).toHaveText(
            faq!.mainEntity.map(q => q.acceptedAnswer.text),
        )

        // Every footnote points at a listed source, and every source links out.
        const refs = await page
            .locator('a[href^="#source-"]')
            .evaluateAll(links => links.map(a => a.getAttribute('href')))
        expect(refs.length).toBeGreaterThan(0)
        for (const ref of Array.from(new Set(refs))) {
            await expect(page.locator(ref!)).toHaveCount(1)
            await expect(
                page.locator(`${ref} a[href^="https://"]`),
            ).toHaveCount(1)
        }
    })

    test('the home page, the comparison, the sitemap and llms.txt all lead to it', async ({
        page,
    }) => {
        const homeHtml = await (await page.request.get('/')).text()
        // The home FAQ's paragraph and the footer.
        expect(linkCount(homeHtml, PATH)).toBeGreaterThanOrEqual(2)

        const compareHtml = await (
            await page.request.get('/compare/coupon-extensions')
        ).text()
        expect(linkCount(compareHtml, PATH)).toBeGreaterThanOrEqual(1)

        const sitemap = await (await page.request.get('/sitemap.xml')).text()
        expect(sitemap).toMatch(/<loc>https?:\/\/[^<]+\/honey-extension<\/loc>/)

        const llms = await (await page.request.get('/llms.txt')).text()
        expect(llms).toMatch(/\/honey-extension\)/)
        const llmsFull = await (await page.request.get('/llms-full.txt')).text()
        expect(llmsFull).toContain('## The Honey extension, explained')
    })

    test('its links to the home page and the comparison work', async ({
        page,
    }) => {
        await page.goto(PATH)
        const faqSection = page.locator(
            'section[aria-labelledby="honey-faq-heading"]',
        )
        await faqSection
            .getByRole('link', { name: 'the best coupon extensions compared' })
            .click()
        await expect(page).toHaveURL(/\/compare\/coupon-extensions$/)
        await expect(page.locator('h1')).toContainText('coupon extensions')

        await page.goto(PATH)
        await faqSection
            .getByRole('link', {
                name: 'Caramel, the open-source Honey alternative',
            })
            .click()
        await expect(page).toHaveURL(/\/$/)
    })

    test('desktop Chrome gets an Add to Chrome link that leaves once the extension is installed', async ({
        page,
    }) => {
        await page.goto(PATH)
        const link = calloutLink(page)
        await expect(link).toHaveText('Add to Chrome')
        await expect(link).toHaveAttribute(
            'href',
            /^https:\/\/chromewebstore\.google\.com\/detail\//,
        )
        await expect(link).toHaveAttribute('target', '_blank')

        // Exactly what an installed extension does on grabcaramel.com.
        await page.evaluate(() =>
            document.documentElement.setAttribute(
                'data-caramel-extension',
                'e2e',
            ),
        )
        await expect(calloutLink(page)).toHaveCount(0)
    })
})
