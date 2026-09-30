import { expect, test } from '@playwright/test'

// The home page's crawlable links into the store pages, checked in the SERVER
// HTML (what a crawler sees before any script runs), not the hydrated DOM.
//
// 1. The "Supported stores" marquee cards link to their store pages. Before
//    2026-09-30 they were plain <div>s, so the home page (the site's
//    strongest page) linked to no store page at all.
// 2. "Codes that just worked" is rendered on the server (RecentlyWorkedSection)
//    instead of fetched after hydration, so its store links are in the HTML
//    too. That half needs a worked signal in the DB, so it runs only where the
//    spec owns a database (hermetic e2e-pr/local), never against a deployment.

const FEATURED_STORE_PATHS = [
    '/coupons/amazon.com',
    '/coupons/ebay.com',
    '/coupons/codecademy.com',
    '/coupons/bestbuy.com',
    '/coupons/target.com',
    '/coupons/walmart.com',
    '/coupons/nike.com',
    '/coupons/adidas.com',
]

test.describe('home page store links', () => {
    test.describe.configure({ timeout: 60000 })

    test('the server HTML links every featured store to its store page', async ({
        request,
    }) => {
        const res = await request.get('/')
        expect(res.status()).toBe(200)
        const html = await res.text()
        for (const path of FEATURED_STORE_PATHS) {
            expect(html, `home HTML links ${path}`).toContain(`href="${path}"`)
        }
    })

    test('a supported-store card opens that store page', async ({ page }) => {
        // The marquee never stops moving otherwise, so Playwright's
        // actionability check would never see a stable card; reduced motion
        // is a real visitor setting the page honours (animation: none).
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto('/', { waitUntil: 'load' })
        // The marquee renders each store twice (the second copy is
        // aria-hidden for the seamless loop); the accessible one is first.
        const amazon = page.getByRole('link', {
            name: 'Amazon coupon codes',
        })
        await amazon.first().scrollIntoViewIfNeeded()
        await amazon.first().click()
        await expect(page).toHaveURL(/\/coupons\/amazon\.com$/)
        await expect(
            page.getByRole('heading', {
                level: 1,
                name: 'Best amazon.com coupon codes today',
            }),
        ).toBeVisible()
    })
})

// Seed coupon 900000001 (SAVE10NOW, ebay.com) from the catalog_seed migration.
const SEED_COUPON_ID = '900000001'

test.describe('home page "Codes that just worked" (server-rendered)', () => {
    test.describe.configure({ timeout: 60000 })
    test.skip(
        !process.env.DATABASE_URL,
        'needs the hermetic DB: it records a worked signal and removes it',
    )

    // TEST-ONLY DB access, announced: the report route below writes the
    // signal the real way; this only records whether a row existed first
    // and removes the one the test created, so the visual-regression home
    // screenshot (same run, same DB) never sees a strip it did not expect.
    let signalExisted = false

    test.beforeAll(async () => {
        const { PrismaClient } = await import('@prisma/client')
        const prisma = new PrismaClient()
        try {
            signalExisted =
                (await prisma.couponSignal.findUnique({
                    where: { couponId: SEED_COUPON_ID },
                })) !== null
        } finally {
            await prisma.$disconnect()
        }
    })

    test.afterAll(async () => {
        if (signalExisted) return
        const { PrismaClient } = await import('@prisma/client')
        const prisma = new PrismaClient()
        try {
            await prisma.couponSignal.deleteMany({
                where: { couponId: SEED_COUPON_ID },
            })
        } finally {
            await prisma.$disconnect()
        }
    })

    test('a code reported as worked appears in the home HTML with its store link', async ({
        request,
        page,
        baseURL,
    }) => {
        if (!baseURL) throw new Error('playwright baseURL is not set')
        const report = await request.post(
            `/api/coupons/${SEED_COUPON_ID}/report`,
            {
                data: { outcome: 'worked' },
                headers: { Origin: new URL(baseURL).origin },
            },
        )
        expect(report.status(), await report.text()).toBe(200)

        const html = await (await request.get('/')).text()
        expect(html).toContain('id="just-worked"')
        const strip = html.slice(html.indexOf('id="just-worked"'))
        expect(strip).toContain('href="/coupons/ebay.com"')
        expect(strip).toContain('SAVE10NOW')

        // And the hydrated page keeps it (the client clock re-check must
        // not drop a code that worked seconds ago).
        await page.goto('/', { waitUntil: 'load' })
        const section = page.locator('#just-worked')
        await expect(
            section.getByRole('heading', { name: 'Codes that just worked' }),
        ).toBeVisible()
        await expect(section.getByText('SAVE10NOW')).toBeVisible()
        await expect(
            section.getByText('Just worked', { exact: true }),
        ).toBeVisible()
    })
})
