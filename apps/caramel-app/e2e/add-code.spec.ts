import { expect, test } from '@playwright/test'
import { normalizeShopperCode } from '../src/lib/shopperCoupons'
import { seedVerifiedUser } from './support/seed-user'
import { firstLinkedStoreDomain } from './support/stores'

// The "Add a code" form on /coupons/[store] (shopper-submitted codes, owner
// directed 2026-10-02). Two contexts, per CLAUDE.md's e2e rules (docs/agent/conventions-and-checks.md):
//   - the signed-out assertion is DEPLOYMENT-SAFE and ungated: it only reads the
//     page, so it runs hermetically (e2e-pr / local) AND against the live dev
//     site (e2e-push);
//   - the signed-in add WRITES a catalog row and needs a seedable user, so it is
//     gated on DATABASE_URL and cleans its row up by id.
//
// A store is "known" (the form renders at all) only when a SUPPLIER coupon or a
// store_configs row exists; a shopper-only domain does not show it. The ungated
// signed-out test therefore picks a store from the deployment's own
// /supported-stores links (firstLinkedStoreDomain). STORE below is amazon.com for
// the DB-gated tests only: those run hermetically, where it is in the synthetic
// seed.
const STORE = 'amazon.com'
const SEEDABLE = !!process.env.DATABASE_URL
const ADD_CODE_EMAIL = 'e2e-add-code@caramel.dev'
const ADD_CODE_PASSWORD = 'E2ePass1234'
const seedBaseURL =
    process.env.PLAYWRIGHT_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:58000'

test.describe('Add a code — signed out', () => {
    test('a signed-out visitor is asked to sign in to share a code', async ({
        page,
    }) => {
        // A store the CURRENT deployment itself links to, never a hard-coded
        // one: dev's catalog may not have amazon.com as a known store.
        const site = await firstLinkedStoreDomain(page)
        await page.goto(`/coupons/${site}`)
        const prompt = page.getByRole('link', {
            name: 'Sign in to share a code',
        })
        await expect(prompt).toBeVisible({ timeout: 15000 })
        await expect(prompt).toHaveAttribute('href', '/login')
        // No form for a signed-out visitor.
        await expect(
            page.getByRole('textbox', { name: 'Coupon code' }),
        ).toHaveCount(0)
    })
})

/** Delete the shopper row the test created. @prisma/client is imported LAZILY: the
 * e2e-push lane has no generated client, and a top-level import would crash this
 * whole file at collection time, before the DATABASE_URL skip gate can run. */
async function deleteCouponById(couponId: string): Promise<void> {
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient()
    try {
        await prisma.coupon.deleteMany({ where: { id: couponId } })
    } finally {
        await prisma.$disconnect()
    }
}

test.describe('Add a code — signed in (real session, local DB)', () => {
    test.skip(!SEEDABLE, 'needs a seedable local/CI Postgres (DATABASE_URL)')

    test.beforeAll(async () => {
        await seedVerifiedUser({
            baseURL: seedBaseURL,
            email: ADD_CODE_EMAIL,
            password: ADD_CODE_PASSWORD,
            name: 'E2E Add Code User',
        })
    })

    test('a signed-in shopper adds a code and it lists as Unverified', async ({
        page,
    }) => {
        // Base-36, NOT decimal: `E2E${Date.now()}` is 16 characters holding 14
        // digits, which looksLikeCardNumber (shopperCoupons.ts) refuses as the
        // shape of a card number, so the form blocked the submit client-side
        // and no POST ever fired (the CI timeout on PR #289). Unique per run.
        const code = `E2E${Date.now().toString(36).toUpperCase()}`
        // Fail HERE, naming the cause, if the generated code is ever one the
        // form itself would refuse, instead of as a waitForResponse timeout.
        expect(
            normalizeShopperCode(code),
            `the e2e code ${code} must be a code the form accepts`,
        ).toBe(code)
        let couponId: string | null = null
        try {
            await page.goto('/login')
            await page.getByPlaceholder('you@example.com').fill(ADD_CODE_EMAIL)
            await page
                .getByPlaceholder('Enter your password')
                .fill(ADD_CODE_PASSWORD)
            await page
                .getByRole('button', { name: 'Sign in', exact: true })
                .click()
            await expect(page).toHaveURL(/\/$/, { timeout: 15000 })

            await page.goto(`/coupons/${STORE}`)
            // The form is a known-store, signed-in-only render: assert it is
            // there so a missing form fails as that, not as a missing POST.
            await expect(
                page.getByRole('heading', {
                    name: `Know a code for ${STORE}?`,
                }),
            ).toBeVisible({ timeout: 15000 })
            await page.getByRole('textbox', { name: 'Coupon code' }).fill(code)

            const submitResponse = page.waitForResponse(
                res =>
                    res.url().endsWith('/api/coupons/submit') &&
                    res.request().method() === 'POST',
            )
            await page.getByRole('button', { name: 'Add code' }).click()
            const res = await submitResponse
            expect(res.status()).toBe(200)
            const body = (await res.json()) as {
                couponId: string
                created: boolean
                status: string
            }
            couponId = body.couponId
            expect(body.created).toBe(true)
            expect(body.status).toBe('unverified')
            // Reserved shopper id range (>= 9e17, 18 digits).
            expect(couponId).toMatch(/^[9]\d{17}$/)

            await expect(page.getByText(/Added as Unverified/)).toBeVisible()

            // After a reload the store page lists the new row, titled from the
            // code and badged Unverified (status 'pending').
            await page.reload()
            const card = page
                .getByTestId('coupon-card')
                .filter({ hasText: code })
            await expect(card).toBeVisible({ timeout: 15000 })
            await expect(card.getByText('Unverified')).toBeVisible()
        } finally {
            if (couponId !== null) await deleteCouponById(couponId)
        }
    })

    test('an implausible code is refused client-side with a message', async ({
        page,
    }) => {
        await page.goto('/login')
        await page.getByPlaceholder('you@example.com').fill(ADD_CODE_EMAIL)
        await page
            .getByPlaceholder('Enter your password')
            .fill(ADD_CODE_PASSWORD)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page).toHaveURL(/\/$/, { timeout: 15000 })

        await page.goto(`/coupons/${STORE}`)
        let posted = false
        page.on('request', req => {
            if (req.url().endsWith('/api/coupons/submit')) posted = true
        })
        await page.getByRole('textbox', { name: 'Coupon code' }).fill('a b')
        await page.getByRole('button', { name: 'Add code' }).click()
        await expect(
            page.getByText("That doesn't look like a coupon code."),
        ).toBeVisible()
        expect(posted).toBe(false)
    })
})
