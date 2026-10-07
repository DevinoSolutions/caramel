import { expect, test } from '@playwright/test'
import { firstLinkedStoreDomain } from './support/stores'

// Store pages (/coupons/<store>) carry nearly all of the site's search
// impressions. These checks pin what a crawler and an answer engine read
// there, on whatever catalog the target serves:
//   - no card heading is a scraper placeholder ("CODE") or scraped page
//     chrome ("... Competitor Deals • Last Checked ...") — couponTitleText.ts
//   - the ItemList JSON-LD names exactly the cards the page shows
//   - the FAQ's "ranks first" answer names the first card
//   - the server HTML carries up to 20 cards, not 5
// The DB-gated block plants rows with the junk titles seen in the live
// catalog on 2026-09-30 and checks the page and the API both replace them.

const PLACEHOLDER =
    /^(code|codes|coupon|coupons|coupon code|promo|promo code|discount|discount code|voucher|voucher code|deal|deals|sale|offer|offers|get code|show code|get deal)$/i
const SCRAPED_CHROME =
    /\bcompetitor deals\b|\blast checked:|\bshow code\b|\buses today:/i

const STORE_PAGE_SIZE = 20

interface ItemListJsonLd {
    '@type': string
    numberOfItems: number
    itemListElement: { name: string }[]
}

function itemListFrom(html: string): ItemListJsonLd {
    const script =
        /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    const scripts: { '@type'?: string }[] = []
    for (let match = script.exec(html); match; match = script.exec(html)) {
        scripts.push(JSON.parse(match[1] ?? 'null') as { '@type'?: string })
    }
    const list = scripts.find(data => data?.['@type'] === 'ItemList')
    if (!list) throw new Error('store page has no ItemList JSON-LD')
    return list as ItemListJsonLd
}

test.describe('store page SEO content', () => {
    test.describe.configure({ timeout: 60000 })

    test('card titles are real, and the JSON-LD, FAQ and server HTML agree with them', async ({
        page,
        request,
    }) => {
        const store = await firstLinkedStoreDomain(page)
        const res = await request.get(`/coupons/${store}`)
        expect(res.status()).toBe(200)
        const html = await res.text()
        const itemList = itemListFrom(html)

        // Server HTML: min(20, total) cards, each one in the JSON-LD.
        const expectedCards = Math.min(STORE_PAGE_SIZE, itemList.numberOfItems)
        expect(itemList.itemListElement).toHaveLength(expectedCards)
        expect(html.split('data-testid="coupon-card"').length - 1).toBe(
            expectedCards,
        )

        await page.goto(`/coupons/${store}`, { waitUntil: 'load' })
        const titles = (
            await page
                .getByTestId('coupon-card')
                .locator('h3')
                .allTextContents()
        ).map(title => title.trim())
        expect(titles.length).toBeGreaterThanOrEqual(expectedCards)

        for (const title of titles) {
            expect(title, 'placeholder card title').not.toMatch(PLACEHOLDER)
            expect(
                title.toLowerCase().startsWith(`${store} `) &&
                    PLACEHOLDER.test(title.slice(store.length + 1)),
                `"<store> <placeholder>" card title: ${title}`,
            ).toBe(false)
            expect(title, 'scraped page chrome as a title').not.toMatch(
                SCRAPED_CHROME,
            )
        }
        expect(itemList.itemListElement.map(item => item.name)).toEqual(
            titles.slice(0, expectedCards),
        )

        if (expectedCards > 0) {
            const faq = page.locator(
                'section[aria-labelledby="store-faq-heading"]',
            )
            await expect(faq).toContainText(
                `The one Caramel ranks first is "${titles[0]}"`,
            )
        }
    })
})

// Rows planted for the junk-title check: an obviously synthetic store and id
// range (997000xxx; the seed is 9000000xx, the trust-loop fixtures 999000xxx).
const JUNK_SITE = 'e2e-junk-titles.com'
const JUNK_ROWS = [
    {
        id: '997000001',
        code: 'JUNKTEN',
        title: "10% off • 154 Competitor Deals • Last Checked: Just now Top codes Activity Saving hacks FAQ Today's promo codes",
        discountType: 'PERCENTAGE',
        discountAmount: 10,
        rating: 5,
        expected: `10% off at ${JUNK_SITE}`,
    },
    {
        id: '997000002',
        code: 'JUNKCODE',
        title: 'CODE',
        discountType: null,
        discountAmount: null,
        rating: 4,
        expected: `${JUNK_SITE} promo code JUNKCODE`,
    },
]

test.describe('store page replaces junk catalog titles', () => {
    test.describe.configure({ timeout: 60000 })
    test.skip(
        !process.env.DATABASE_URL,
        'needs the hermetic DB: it plants catalog rows and removes them',
    )

    // TEST-ONLY catalog rows, announced: written straight to the hermetic DB
    // to reproduce the live junk titles, and deleted afterwards. Not an app
    // write path; @prisma/client is imported lazily (e2e-push has no client).
    test.beforeAll(async () => {
        const { PrismaClient } = await import('@prisma/client')
        const prisma = new PrismaClient()
        try {
            await prisma.coupon.deleteMany({
                where: { id: { in: JUNK_ROWS.map(row => row.id) } },
            })
            await prisma.coupon.createMany({
                data: JUNK_ROWS.map(row => ({
                    id: row.id,
                    code: row.code,
                    site: JUNK_SITE,
                    title: row.title,
                    description: '',
                    rating: row.rating,
                    discountType: row.discountType,
                    discountAmount: row.discountAmount,
                    status: 'valid',
                })),
            })
        } finally {
            await prisma.$disconnect()
        }
    })

    test.afterAll(async () => {
        const { PrismaClient } = await import('@prisma/client')
        const prisma = new PrismaClient()
        try {
            await prisma.coupon.deleteMany({
                where: { id: { in: JUNK_ROWS.map(row => row.id) } },
            })
        } finally {
            await prisma.$disconnect()
        }
    })

    test('the page, its JSON-LD, its FAQ and /api/coupons show titles built from the row', async ({
        page,
        request,
    }) => {
        const expected = JUNK_ROWS.map(row => row.expected)

        const api = await request.get(
            `/api/coupons?site=${JUNK_SITE}&page=1&limit=10`,
        )
        expect(api.status()).toBe(200)
        const body = (await api.json()) as { coupons: { title: string }[] }
        expect(body.coupons.map(coupon => coupon.title)).toEqual(expected)

        await page.goto(`/coupons/${JUNK_SITE}`, { waitUntil: 'load' })
        const cards = page.getByTestId('coupon-card')
        await expect(cards.locator('h3')).toHaveText(expected)
        await expect(
            page.locator('section[aria-labelledby="store-faq-heading"]'),
        ).toContainText(
            `The one Caramel ranks first is "${expected[0]}" (code JUNKTEN).`,
        )

        const html = await (await request.get(`/coupons/${JUNK_SITE}`)).text()
        expect(
            itemListFrom(html).itemListElement.map(item => item.name),
        ).toEqual(expected)
        expect(html).not.toContain('Competitor Deals')

        // The shopper flow on the same card: reveal and copy the code.
        await page
            .context()
            .grantPermissions(['clipboard-read', 'clipboard-write'])
        await cards
            .nth(1)
            .getByRole('button', { name: 'Get Coupon Code' })
            .click()
        const reveal = cards.nth(1).getByRole('status')
        await expect(reveal).toContainText('Your Code:')
        await expect(reveal).toContainText('JUNKCODE')
    })
})
