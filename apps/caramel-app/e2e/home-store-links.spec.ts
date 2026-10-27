import { expect, test } from './support/test'
import { openTestPrisma } from './support/test-prisma'

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
                name: 'Best Amazon coupon codes today',
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
        'needs the hermetic DB: it seeds a worked signal and removes it',
    )

    // TEST-ONLY DB access, announced: T-6222 means no anonymous caller can
    // stamp a code "worked" through the API any more, so the test seeds the
    // stamp the way a trusted reporter (an established account, or the vetted
    // checkout capture) would have left it. This snapshots the row first and
    // puts it back afterwards (deleting the one the test created), so the
    // visual-regression home screenshot (same run, same DB) never sees a
    // strip it did not expect. The type import is erased at runtime.
    let signalBefore:
        import('../src/generated/prisma/client').CouponSignal | null = null

    test.beforeAll(async () => {
        const prisma = await openTestPrisma()
        try {
            signalBefore = await prisma.couponSignal.findUnique({
                where: { couponId: SEED_COUPON_ID },
            })
        } finally {
            await prisma.$disconnect()
        }
    })

    test.afterAll(async () => {
        const prisma = await openTestPrisma()
        try {
            await prisma.couponSignal.deleteMany({
                where: { couponId: SEED_COUPON_ID },
            })
            if (signalBefore) {
                await prisma.couponSignal.create({ data: signalBefore })
            }
        } finally {
            await prisma.$disconnect()
        }
    })

    test('a code with a trusted worked stamp appears in the home HTML with its store link; anonymous reports cannot put one there', async ({
        request,
        page,
        baseURL,
    }) => {
        if (!baseURL) throw new Error('playwright baseURL is not set')
        const prisma = await openTestPrisma()
        try {
            // T-6222: anonymous "worked" reports are accepted (a 200, so a
            // forger learns nothing) but NEVER stamp lastWorkedAt, however
            // many distinct addresses send them.
            for (const edgeIp of [
                '203.0.113.11',
                '203.0.113.12',
                '203.0.113.13',
            ]) {
                const report = await request.post(
                    `/api/coupons/${SEED_COUPON_ID}/report`,
                    {
                        data: { outcome: 'worked' },
                        headers: {
                            Origin: new URL(baseURL).origin,
                            'cf-connecting-ip': edgeIp,
                        },
                    },
                )
                expect(report.status(), await report.text()).toBe(200)
            }
            const afterAnonymous = await prisma.couponSignal.findUnique({
                where: { couponId: SEED_COUPON_ID },
            })
            expect(afterAnonymous?.lastWorkedAt ?? null).toEqual(
                signalBefore?.lastWorkedAt ?? null,
            )

            // The stamp a trusted reporter leaves behind.
            const stampedAt = new Date()
            await prisma.couponSignal.upsert({
                where: { couponId: SEED_COUPON_ID },
                create: {
                    couponId: SEED_COUPON_ID,
                    lastWorkedAt: stampedAt,
                    workCount: 1,
                },
                update: { lastWorkedAt: stampedAt },
            })
        } finally {
            await prisma.$disconnect()
        }

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
