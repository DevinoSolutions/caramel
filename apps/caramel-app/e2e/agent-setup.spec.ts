import { expect, test, type Locator, type Page } from '@playwright/test'

// /agent-setup and /agent-setup/<agent> — the "Onboard your agent" flow a
// human walks: read the page on a phone, copy the sentence, check the guide
// for their agent, run the verify curl. Real browser, real app, no mocks.
//
// Deployment-safe (docs/testing.md two-context rule): nothing here depends on
// specific catalog rows, so it runs in both the hermetic and deployed
// contexts. The verify call only asserts the response SHAPE.
//
// Layout regression this pins (2026-09-24): the copy sentence used
// `break-all` and broke mid-word ("ag|ent-setup"), and the verify curl box
// scrolled sideways on a 390px phone with no scroll cue. Long URLs now wrap
// only at spaces and URL boundaries (UrlBreakableText's <wbr>s).

const PHONE_WIDTHS = [320, 390] as const
const COPY_SENTENCE =
    /^Fetch and execute the appropriate instructions to set me up for Caramel from https?:\/\/\S+\/agent-setup\/prompt\.md$/
const VERIFY_COMMAND =
    /^curl -s "https?:\/\/\S+\/api\/coupons\?site=nike\.com&limit=1"$/
// A wrapped line may only start after one of these: a space, or a URL /
// command boundary (path slash, query ?/&, hyphen).
const ALLOWED_BEFORE_WRAP = /[\s/?&-]/

/**
 * Walks every rendered character of `el` and returns the places where a new
 * visual line starts right after a character that is not a boundary — i.e.
 * a mid-word break. Empty array = every wrap is at a sane place.
 */
async function midWordBreaks(locator: Locator): Promise<string[]> {
    return locator.evaluate((el, allowed) => {
        const allowedRe = new RegExp(allowed)
        const chars: { ch: string; top: number }[] = []
        const range = document.createRange()
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? ''
            for (let i = 0; i < text.length; i++) {
                range.setStart(node, i)
                range.setEnd(node, i + 1)
                const rect = range.getBoundingClientRect()
                if (rect.width === 0 && rect.height === 0) continue
                chars.push({ ch: text[i], top: Math.round(rect.top) })
            }
        }
        const breaks: string[] = []
        for (let i = 1; i < chars.length; i++) {
            const startsNewLine = chars[i].top > chars[i - 1].top + 2
            if (startsNewLine && !allowedRe.test(chars[i - 1].ch)) {
                const before = chars.slice(Math.max(0, i - 10), i)
                const after = chars.slice(i, i + 10)
                breaks.push(
                    `${before.map(c => c.ch).join('')}|${after.map(c => c.ch).join('')}`,
                )
            }
        }
        return breaks
    }, ALLOWED_BEFORE_WRAP.source)
}

async function expectNoHorizontalScroll(page: Page) {
    const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        boxes: Array.from(document.querySelectorAll('main pre'))
            .filter(pre => pre.scrollWidth > pre.clientWidth)
            .map(pre => (pre.textContent ?? '').slice(0, 60)),
    }))
    expect(overflow.page, 'page scrolls sideways').toBeLessThanOrEqual(0)
    expect(overflow.boxes, 'code boxes that scroll sideways').toEqual([])
}

async function expectCleanWraps(page: Page) {
    const targets = page.locator('main pre, main a[href$="/prompt.md"]')
    const count = await targets.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
        expect(await midWordBreaks(targets.nth(i))).toEqual([])
    }
}

test.describe('Agent setup index', () => {
    for (const width of PHONE_WIDTHS) {
        test(`copy sentence and verify box wrap cleanly at ${width}px`, async ({
            page,
        }) => {
            await page.setViewportSize({ width, height: 800 })
            await page.goto('/agent-setup')

            const sentence = page
                .locator('main pre')
                .filter({ hasText: 'Fetch and execute' })
            const verify = page
                .locator('main pre')
                .filter({ hasText: 'curl -s' })
            await expect(sentence).toBeVisible()
            await expect(verify).toBeVisible()

            // The break points are <wbr>s: the text itself is unchanged.
            expect(await sentence.textContent()).toMatch(COPY_SENTENCE)
            expect(await verify.textContent()).toMatch(VERIFY_COMMAND)
            // At phone width both must actually wrap, or the test proves nothing.
            // One text-sm line plus py-3 padding is 44px; two lines is 64px.
            const boxHeights = await Promise.all(
                [sentence, verify].map(box =>
                    box.evaluate(el => el.getBoundingClientRect().height),
                ),
            )
            for (const height of boxHeights) {
                expect(height).toBeGreaterThan(50)
            }

            await expectNoHorizontalScroll(page)
            await expectCleanWraps(page)
        })
    }

    test('desktop keeps the copy sentence readable with no sideways scroll', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto('/agent-setup')
        await expectNoHorizontalScroll(page)
        await expectCleanWraps(page)
    })

    test('the pill copies the exact sentence shown on the page', async ({
        page,
        context,
    }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/agent-setup')

        const shown = await page
            .locator('main pre')
            .filter({ hasText: 'Fetch and execute' })
            .textContent()
        await page
            .getByRole('button', { name: /onboard your agent to caramel/i })
            .first()
            .click()

        await expect(
            page.getByText(/copied\. paste into any ai/i),
        ).toBeVisible()
        const clipboard = await page.evaluate(() =>
            navigator.clipboard.readText(),
        )
        expect(clipboard).toBe(shown)
        expect(clipboard).toMatch(COPY_SENTENCE)
    })

    test('the verify URL and prompt.md answer for real', async ({ page }) => {
        await page.goto('/agent-setup')
        const command = await page
            .locator('main pre')
            .filter({ hasText: 'curl -s' })
            .textContent()
        const verifyUrl = new URL(/"([^"]+)"/.exec(command ?? '')?.[1] ?? '')

        // Same host as the page under test, so hit it through baseURL.
        const api = await page.request.get(
            verifyUrl.pathname + verifyUrl.search,
        )
        expect(api.status()).toBe(200)
        const body = (await api.json()) as { coupons?: unknown }
        expect(Array.isArray(body.coupons)).toBe(true)

        const prompt = await page.request.get('/agent-setup/prompt.md')
        expect(prompt.status()).toBe(200)
        expect(prompt.headers()['content-type']).toContain('text/markdown')
        expect(await prompt.text()).toContain(
            '/api/coupons?site=nike.com&limit=1',
        )
    })
})

test.describe('Agent setup guides', () => {
    test('every guide linked from the index wraps cleanly on a phone', async ({
        page,
    }) => {
        await page.goto('/agent-setup')
        const hrefs = await page
            .locator('main a[href^="/agent-setup/"]')
            .evaluateAll(links =>
                Array.from(
                    new Set(links.map(a => a.getAttribute('href') ?? '')),
                ),
            )
        const guides = hrefs.filter(href => !href.endsWith('.md'))
        expect(guides.length).toBeGreaterThanOrEqual(5)

        for (const width of PHONE_WIDTHS) {
            await page.setViewportSize({ width, height: 800 })
            for (const href of guides) {
                await test.step(`${href} at ${width}px`, async () => {
                    await page.goto(href)
                    await expect(
                        page.getByRole('heading', { level: 1 }),
                    ).toContainText('Set up Caramel in')
                    await expect(
                        page.locator('main pre').filter({ hasText: 'curl -s' }),
                    ).toHaveText(VERIFY_COMMAND)
                    await expectNoHorizontalScroll(page)
                    await expectCleanWraps(page)
                })
            }
        }
    })
})
