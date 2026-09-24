import { GET as filtersGET } from '@/app/api/coupons/filters/route'
import { GET as couponsGET } from '@/app/api/coupons/route'
import { GET as statsGET } from '@/app/api/coupons/stats/route'
import { GET as storesGET } from '@/app/api/coupons/stores/route'
import { GET as supportedStoresGET } from '@/app/api/extension/supported-stores/route'
import { POST as searchSupportedPOST } from '@/app/api/sites/search-supported/route'
import { GET as topSitesGET } from '@/app/api/sites/top-sites/route'
import { GET as sourcesGET } from '@/app/api/sources/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-001 — proves parseCouponRows is actually wired into all 9 read sites:
// (a) a production-shaped fixture (including the runtime-type traps — numeric
// columns as strings, an int4 id as a number) flows through each route into
// the correct response shape, and (b) a drifted row causes the flagship route
// (coupons/route.ts) to fail loudly (500 + Sentry), not silently. Schema-level
// accept/reject coverage lives in couponsDb-schemas.test.ts; this file is the
// route-wiring proof.
//
// W4 — the 9 reads run on the app's Prisma catalog via
// `prisma.$queryRaw(Prisma.sql`...`)`, so `@/lib/prisma` is mocked: its
// `$queryRaw` is a recording, rule-based resolver keyed on the composed `.sql`
// (flattened `?`-placeholder text) so one factory serves every route's
// distinct query shape, including routes that issue more than one query per
// request (coupons/route.ts's list+count, filters/route.ts's sites+types).
// Unmatched calls resolve to `[]`.
type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
// Composed `.sql` text of every $queryRaw call this run made, in order — lets
// a test assert on the QUERY SHAPE itself (e.g. "does this route still
// reference a column that doesn't exist"), which the rule-based row mocking
// can't: rules only ever match `sql`, never expose it to the test.
let capturedQueries: string[] = []
let capturedValues: unknown[][] = []

function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

// coupons/route.ts + the store page also call attachSignals() → couponSignal;
// stub it so the merge sees no signals (each coupon gets lastWorkedAt:null,
// asserted below). $queryRaw receives a Prisma.Sql whose `.sql` getter is the
// composed query text.
vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string; values?: unknown[] }) => {
            capturedQueries.push(arg.sql)
            capturedValues.push(arg.values ?? [])
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
        couponSignal: { findMany: vi.fn(async () => []) },
    },
}))

vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
    isTrustedServer: () => false,
    isOriginAllowed: () => true,
    forbiddenOrigin: () =>
        new Response(JSON.stringify({ error: 'Forbidden origin' }), {
            status: 403,
        }),
}))

const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
}))

beforeEach(() => {
    rules = []
    capturedQueries = []
    capturedValues = []
    captureExceptionMock.mockClear()
})

// Production-shaped: id as a number (int4), rating/discount_amount as
// numeric-column strings — exercises the exact coercion traps
// couponsDb.ts's schemas exist to handle.
const couponFixture = {
    id: 42,
    code: 'SAVE10',
    site: 'example.com',
    title: 'Save 10% at Example',
    description: '10% off your order',
    rating: '4.5',
    discount_type: 'PERCENTAGE',
    discount_amount: '10',
    expiry: '2026-12-31',
    expired: false,
    timesUsed: 5,
    status: 'valid',
    verificationMessage: null,
}

describe('GET /api/coupons — list+count (CouponListRow + TotalCountRow)', () => {
    it('parses a production-shaped fixture: coerces the numeric id/rating/discount_amount, returns the full envelope', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 1 }])

        const res = await couponsGET(
            new NextRequest('http://localhost/api/coupons'),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.coupons).toHaveLength(1)
        expect(body.coupons[0]).toEqual({
            ...couponFixture,
            id: '42',
            rating: 4.5,
            discount_amount: 10,
            // attachSignals merges this on; no seeded signal → null.
            lastWorkedAt: null,
        })
        expect(body.total).toBe(1)
        expect(body.hasMore).toBe(false)
    })

    it('a drifted row (missing required column) fails loudly: 500 + Sentry.captureException, not a silent/malformed 200', async () => {
        const { code: _drop, ...drifted } = couponFixture
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [drifted],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 1 }])

        const res = await couponsGET(
            new NextRequest('http://localhost/api/coupons'),
        )
        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body.error).toBe('Error fetching coupons.')
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [capturedErr] = captureExceptionMock.mock.calls[0]
        expect(capturedErr.message).toContain('coupons-db schema drift')
        expect(capturedErr.message).toContain('coupons.list')
    })
})

describe('GET /api/coupons/stores (SiteRow)', () => {
    it('filters a null site out (SiteRowSchema is nullable, consuming code already defends against it)', async () => {
        mockRows(
            sql => sql.includes('SELECT DISTINCT site'),
            [{ site: 'b.com' }, { site: 'a.com' }, { site: null }],
        )

        const res = await storesGET(
            new NextRequest('http://localhost/api/coupons/stores'),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sites: ['b.com', 'a.com'] })
    })
})

describe('GET /api/coupons/stats (StatsRow)', () => {
    it('computes active = total - expired from the ::int-cast aggregate', async () => {
        mockRows(
            sql => sql.includes('COUNT(*) FILTER'),
            [{ total: 10, expired: 3 }],
        )

        const res = await statsGET(
            new NextRequest('http://localhost/api/coupons/stats'),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ total: 10, expired: 3, active: 7 })
    })
})

describe('GET /api/coupons/filters (SiteRow + DiscountTypeRow)', () => {
    it('sorts sites, de-dupes discount types, both queries parsed independently', async () => {
        mockRows(
            sql => sql.includes('DISTINCT site') && sql.includes('IS NOT NULL'),
            [{ site: 'b.com' }, { site: 'a.com' }],
        )
        mockRows(
            sql => sql.includes('DISTINCT discount_type'),
            [
                { discount_type: 'PERCENTAGE' },
                { discount_type: 'CASH' },
                { discount_type: 'PERCENTAGE' },
            ],
        )

        const res = await filtersGET(
            new NextRequest('http://localhost/api/coupons/filters'),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            sites: ['a.com', 'b.com'],
            discountTypes: ['PERCENTAGE', 'CASH'],
        })
    })
})

describe('GET /api/sites/top-sites (SiteCountRow)', () => {
    it('parses the grouped {site,coupon_count} shape (fixes the pre-fix incomplete generic that omitted coupon_count)', async () => {
        mockRows(
            sql => sql.includes('AS coupon_count'),
            [
                { site: 'a.com', coupon_count: 5 },
                { site: 'b.com', coupon_count: 3 },
            ],
        )

        const res = await topSitesGET(
            new NextRequest('http://localhost/api/sites/top-sites'),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sites: ['a.com', 'b.com'] })
    })
})

describe('POST /api/sites/search-supported (SiteRow)', () => {
    it('parses the DISTINCT site rows', async () => {
        mockRows(
            sql => sql.includes('SELECT DISTINCT site'),
            [{ site: 'example.com' }],
        )

        const req = new NextRequest(
            'http://localhost/api/sites/search-supported',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: 'exa' }),
            },
        )
        const res = await searchSupportedPOST(req)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sites: ['example.com'] })
    })

    it('searches a pasted product URL by its store domain', async () => {
        // The box's placeholder is a URL, so shoppers paste one; the catalogue
        // holds bare domains, so the SQL must see `amazon.com`, not the URL.
        mockRows(
            sql => sql.includes('SELECT DISTINCT site'),
            [{ site: 'amazon.com' }],
        )

        const req = new NextRequest(
            'http://localhost/api/sites/search-supported',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: 'https://www.amazon.com/dp/B092PZ16MC?ref=cm_sw_r',
                }),
            },
        )
        const res = await searchSupportedPOST(req)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sites: ['amazon.com'] })
        expect(capturedValues[capturedValues.length - 1]).toContain(
            '%amazon.com%',
        )
    })
})

describe('GET /api/sources (SourceRow)', () => {
    it('parses the sources+coupons aggregate and computes successRate', async () => {
        mockRows(
            sql => sql.includes('FROM sources'),
            [
                {
                    id: 'src1',
                    source: 'Example Source',
                    websites: ['example.com'],
                    status: 'ACTIVE',
                    total_coupons: 10,
                    total_used: 6,
                    total_expired: 2,
                },
            ],
        )

        const res = await sourcesGET(
            new NextRequest('http://localhost/api/sources'),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.data).toEqual([
            {
                id: 'src1',
                source: 'Example Source',
                websites: ['example.com'],
                numberOfCoupons: 10,
                successRate: 75,
                status: 'ACTIVE',
            },
        ])
    })

    // Regression pin: coupons.source_id has never existed (the external
    // catalog never had it and the app's Coupon model doesn't either), so the
    // real, schema-verified relationship is sources.websites[] (the domains a
    // source covers) against coupons.site (each coupon's own domain). The
    // rule-based row mock can't catch a bad JOIN column by itself (it never
    // runs real SQL), so this test inspects the composed query text instead.
    it('joins coupons via the real schema (site ∈ websites[]) — never the phantom coupons.source_id column', async () => {
        mockRows(sql => sql.includes('FROM sources'), [])

        await sourcesGET(new NextRequest('http://localhost/api/sources'))

        const sourcesQuery = capturedQueries.find(q =>
            q.includes('FROM sources'),
        )
        expect(sourcesQuery).toBeDefined()
        expect(sourcesQuery).not.toMatch(/source_id/)
        expect(sourcesQuery).toMatch(/ANY\(s\.websites\)/)
    })
})

describe('GET /api/extension/supported-stores (StoreConfigRow)', () => {
    it('maps xpath columns to the extension contract, undefined (not null) for absent optional fields', async () => {
        mockRows(
            sql => sql.includes('FROM store_configs'),
            [
                {
                    store_name: 'example.com',
                    show_input_xpath: null,
                    dismiss_button_xpath: null,
                    coupon_input_xpath: '//input',
                    apply_button_xpath: '//button',
                    price_container_xpath: null,
                    success_indicator_xpath: '//success',
                    error_indicator_xpath: '//error',
                    coupon_remove_xpath: '//remove',
                },
            ],
        )

        const res = await supportedStoresGET(
            new NextRequest('http://localhost/api/extension/supported-stores'),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            supported: [
                {
                    domain: 'example.com',
                    couponInput: '//input',
                    couponSubmit: '//button',
                    priceContainer: undefined,
                    showInput: undefined,
                    dismissButton: undefined,
                    successIndicator: '//success',
                    errorIndicator: '//error',
                    couponRemove: '//remove',
                },
            ],
        })
    })
})
