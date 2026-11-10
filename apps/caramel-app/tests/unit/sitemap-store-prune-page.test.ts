import StoreCouponsPage, {
    generateMetadata,
} from '@/app/(marketing)/coupons/[store]/page'
import { SITEMAP_PRUNE_BASES } from '@/lib/seo/sitemapStorePrune.data'
import { evaluateStorePageIndexability } from '@/lib/seo/storeIndexability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-15493 — a store the sitemap prune leaves out is still a live, indexable
// page. Uses a REAL entry of the generated prune list (not a fixture) and the
// same mocked-Prisma harness as coupons-store-page.test.ts: the page still
// renders its coupons and its metadata carries NO robots override (an
// indexable page has none; a noindexed one is `{ index: false, ... }`).
//
// The wiring half (the prune module is imported by src/app/sitemap.ts only)
// lives in sitemap-store-prune.test.ts.

type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) =>
            Promise.resolve(rules.find(r => r.match(arg.sql))?.rows ?? []),
        couponSignal: { findMany: vi.fn(async () => []) },
    },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/components/coupons/coupons-section', () => ({
    default: () => null,
}))

const PRUNED_BASE = SITEMAP_PRUNE_BASES[0]!

const supplierRow = {
    id: 42,
    code: 'SAVE10',
    site: PRUNED_BASE,
    title: 'Save 10%',
    description: '10% off your order',
    rating: '4.5',
    discount_type: 'PERCENTAGE',
    discount_amount: '10',
    expiry: '2026-12-31',
    expired: false,
    timesUsed: 5,
    status: 'valid',
    verificationMessage: null,
    newCustomersOnly: false,
    isSupplier: true,
}

beforeEach(() => {
    rules = [
        { match: sql => sql.includes('AS known'), rows: [{ known: true }] },
        {
            match: sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            rows: [supplierRow],
        },
        {
            match: sql => sql.includes('COUNT(*)::int AS total'),
            rows: [
                {
                    total: 1,
                    percent_off_codes: 1,
                    best_percent_off: 10,
                    fixed_amount_codes: 0,
                    last_updated: new Date('2026-09-24T12:00:00Z'),
                },
            ],
        },
    ]
})

describe('a store pruned from the sitemap stays a live, indexable page', () => {
    it('picked a real entry of the generated list', () => {
        expect(PRUNED_BASE).toMatch(/\./)
    })

    it('has no robots override in its metadata (indexable) and still canonicalizes to itself', async () => {
        const metadata = await generateMetadata({
            params: { store: PRUNED_BASE },
        })

        expect(metadata.robots).toBeUndefined()
        expect(String(metadata.alternates?.canonical)).toMatch(
            new RegExp(`/coupons/${PRUNED_BASE.replace(/\./g, '\\.')}$`),
        )
    })

    it('still renders the page (no notFound, no redirect)', async () => {
        const page = await StoreCouponsPage({ params: { store: PRUNED_BASE } })
        expect(page).toBeTruthy()
    })

    it('is indexable under the shared policy, unchanged by the prune', () => {
        expect(
            evaluateStorePageIndexability({
                base: PRUNED_BASE,
                visibleCouponCount: 1,
            }),
        ).toEqual({ indexable: true, reason: null })
    })
})
