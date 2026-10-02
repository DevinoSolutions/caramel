import {
    RESTRICTED_COUPON_STATUSES,
    VISIBLE_COUPON_STATUSES,
} from '@/lib/coupons'
import {
    expireCoupons,
    getCouponStats,
    listCoupons,
    listNeighbourStoreRows,
    listRecentlyWorkedCoupons,
    listStoreCoupons,
    listStoreSitemapEntries,
    requestSource,
    submitShopperCoupon,
} from '@/lib/couponsRepo'
import {
    SHOPPER_COUPON_DESCRIPTION,
    SHOPPER_DAILY_SUBMISSION_CAP,
    ShopperSubmissionLimitError,
} from '@/lib/shopperCoupons'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Direct fn-level pins for couponsRepo.ts (coverage that doesn't route through
// an HTTP handler). Exhaustive query-shape/behavior pinning per route lives in
// coupons-read-boundary.test.ts, coupons-visibility.test.ts,
// coupons-store-page.test.ts, supported-stores.test.ts, and
// coupons-expire.test.ts — this file is deliberately NOT a duplicate of those.
//
// W4-D2: reads AND writes now run on the app's own Prisma catalog, so a single
// mocked `@/lib/prisma` covers both. `$queryRaw` (reads) records the composed
// `.sql` (flattened `?`-placeholder text) and returns rule-matched rows;
// `$executeRaw` (expire) records its `.sql` and returns a preset affected-row
// count; `source.create` (requestSource) records its args. parseCouponRows +
// the real row schemas come from the UNMOCKED couponsDb (the reads' zod parse).
type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
// Raw SQL text of every DB call, in order — lets a test assert on the
// generated QUERY SHAPE itself.
let capturedQueries: string[] = []
// The bound parameter VALUES of every $queryRaw/$executeRaw, index-aligned with capturedQueries — lets a
// test assert on what was actually bound (e.g. the lowercased store base).
let capturedValues: unknown[][] = []
// Affected-row count the mocked $executeRaw returns (expire).
let executeRawResult = 0
// Args every prisma.source.create() was called with (requestSource).
let capturedSourceCreates: unknown[] = []
// How many prisma.$transaction() calls were opened (submitShopperCoupon).
let transactionCount = 0
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

// prisma.$queryRaw / $executeRaw receive a Prisma.Sql whose `.sql` getter is the
// composed, flattened query text (nested fragments inlined, values as `?`).
vi.mock('@/lib/prisma', () => {
    const client = {
        $queryRaw: (arg: { sql: string; values: unknown[] }) => {
            capturedQueries.push(arg.sql)
            capturedValues.push(arg.values)
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
        $executeRaw: (arg: { sql: string; values: unknown[] }) => {
            capturedQueries.push(arg.sql)
            capturedValues.push(arg.values)
            return Promise.resolve(executeRawResult)
        },
        // submitShopperCoupon's interactive transaction: the callback gets this
        // same recording client, and each opened transaction is counted so a
        // test can assert "dedupe + insert run in ONE transaction".
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
            transactionCount += 1
            return fn(client)
        },
        couponSignal: { findMany: vi.fn(async () => []) },
        source: {
            create: (arg: unknown) => {
                capturedSourceCreates.push(arg)
                return Promise.resolve({})
            },
        },
    }
    return { default: client }
})

beforeEach(() => {
    rules = []
    capturedQueries = []
    capturedValues = []
    executeRawResult = 0
    capturedSourceCreates = []
    transactionCount = 0
})

/** The store page's count row: the total plus the FAQ facts folded into the
 *  same aggregate (couponsDb.ts StoreCouponAggregateRowSchema). */
function storeAggregateRow(total: number) {
    return {
        total,
        percent_off_codes: total,
        best_percent_off: total > 0 ? 10 : null,
        fixed_amount_codes: 0,
        last_updated: total > 0 ? new Date('2026-09-24T12:00:00Z') : null,
    }
}

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

describe('listCoupons', () => {
    it('parses a production-shaped fixture and derives total from the TotalCountRow', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 1 }])

        const result = await listCoupons({ limit: 10, skip: 0 })
        expect(result.coupons).toEqual([
            { ...couponFixture, id: '42', rating: 4.5, discount_amount: 10 },
        ])
        expect(result.total).toBe(1)
    })

    it('both listing reads hand shoppers the store sentence of a restricted coupon and never the verifier log', async () => {
        const rows = [
            {
                ...couponFixture,
                id: 1,
                status: 'valid',
                verificationMessage:
                    'Discount code accepted (Shopify cart.json; cart 1 item / 45.00 USD)',
            },
            {
                ...couponFixture,
                id: 2,
                status: 'retry',
                verificationMessage: 'Verification timed out after 120s',
            },
            {
                ...couponFixture,
                id: 3,
                status: 'product_restriction',
                verificationMessage: 'basket.error.bagNotFound',
            },
            {
                ...couponFixture,
                id: 4,
                status: 'product_restriction',
                verificationMessage: 'Your cart contains ineligible products.',
            },
        ]
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            rows,
        )
        mockRows(sql => sql.includes('COUNT(*)'), [storeAggregateRow(4)])

        for (const read of [
            () => listCoupons({ limit: 10, skip: 0 }),
            () => listStoreCoupons('example.com', 10),
        ]) {
            const { coupons } = await read()
            expect(coupons.map(c => [c.id, c.verificationMessage])).toEqual([
                ['1', null],
                ['2', null],
                ['3', null],
                ['4', 'Your cart contains ineligible products.'],
            ])
        }
    })

    it('both listing reads replace a placeholder or scraped-chrome title with one built from the row (couponTitleText.ts)', async () => {
        const rows = [
            { ...couponFixture, id: 1, title: 'CODE', discount_amount: null },
            {
                ...couponFixture,
                id: 2,
                title: "10% off • 154 Competitor Deals • Last Checked: Just now Top codes Activity Saving hacks FAQ Today's Coursera promo codes & verif",
            },
            { ...couponFixture, id: 3 },
        ]
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            rows,
        )
        mockRows(sql => sql.includes('COUNT(*)'), [storeAggregateRow(3)])

        for (const read of [
            () => listCoupons({ limit: 10, skip: 0 }),
            () => listStoreCoupons('example.com', 10),
        ]) {
            const { coupons } = await read()
            expect(coupons.map(c => c.title)).toEqual([
                'example.com promo code SAVE10',
                '10% off at example.com',
                'Save 10% at Example',
            ])
        }
    })

    it('an empty total row falls back to 0 (no coupons is legitimate, not drift)', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [])

        const result = await listCoupons({ limit: 10, skip: 0 })
        expect(result).toEqual({ coupons: [], total: 0 })
    })
})

describe('listCoupons discount_type filter (case-insensitive)', () => {
    it('generates a casing-tolerant predicate so lowercase producer rows are not dropped', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 0 }])

        await listCoupons({ type: 'PERCENTAGE', limit: 10, skip: 0 })

        // Target the discount_type PREDICATE fragment in the composed SQL —
        // matched by shape, not the bare column name, since the SELECT column
        // list also contains `discount_type`.
        const predicate = capturedQueries.find(q =>
            /discount_type\)?\s*=/i.test(q),
        )
        expect(predicate).toBeDefined()
        expect(predicate).toMatch(/UPPER\(discount_type\)\s*=\s*UPPER\(/i)
        // Guard against a regression to the bare, case-sensitive equality.
        expect(
            capturedQueries.some(q => /discount_type\s*=\s*\?/.test(q)),
        ).toBe(false)
    })

    it('adds no discount_type filter predicate when type is "all"', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 0 }])

        await listCoupons({ type: 'all', limit: 10, skip: 0 })

        // The SELECT column list names `discount_type`, so assert on the
        // PREDICATE shape (a `discount_type =` comparison), not the column.
        const hasTypePredicate = capturedQueries.some(
            q =>
                /UPPER\(discount_type\)\s*=/i.test(q) ||
                /discount_type\s*=\s*\?/.test(q),
        )
        expect(hasTypePredicate).toBe(false)
    })
})

describe('getCouponStats', () => {
    it('falls back to {total:0,expired:0} when the aggregate returns no row (the fallback moved here from the route)', async () => {
        mockRows(sql => sql.includes('COUNT(*) FILTER'), [])

        const stats = await getCouponStats()
        expect(stats).toEqual({ total: 0, expired: 0 })
    })

    it('returns the parsed aggregate row as-is when present', async () => {
        mockRows(
            sql => sql.includes('COUNT(*) FILTER'),
            [{ total: 10, expired: 3 }],
        )

        const stats = await getCouponStats()
        expect(stats).toEqual({ total: 10, expired: 3 })
    })
})

describe('expireCoupons (write, app catalog via prisma.$executeRaw)', () => {
    it('UPDATEs the app coupons table and returns the affected-row count directly', async () => {
        executeRawResult = 2

        await expect(expireCoupons(['1', '2'])).resolves.toBe(2)

        // The intent SQL — an UPDATE flipping expired=TRUE on the app catalog,
        // guarded to only-currently-live rows (so the count = FALSE→TRUE
        // transitions), on our OWN table via prisma.$executeRaw (never an
        // external coupons DB).
        expect(capturedQueries).toHaveLength(1)
        expect(capturedQueries[0]).toContain('UPDATE coupons')
        expect(capturedQueries[0]).toContain('expired = TRUE')
        expect(capturedQueries[0]).toContain('expired = FALSE')
    })

    it('returns 0 when no live row matched (executeRaw affected 0)', async () => {
        executeRawResult = 0

        await expect(expireCoupons(['999999'])).resolves.toBe(0)
        expect(capturedQueries).toHaveLength(1)
    })

    it('short-circuits an empty id list to 0 WITHOUT issuing SQL (IN () is invalid)', async () => {
        await expect(expireCoupons([])).resolves.toBe(0)
        expect(capturedQueries).toHaveLength(0)
    })
})

describe('requestSource (write, app sources INSERT via prisma.source.create)', () => {
    it('creates a REQUESTED source row (empty websites[], minted id) and resolves void', async () => {
        await expect(requestSource('example.com')).resolves.toBeUndefined()

        expect(capturedSourceCreates).toHaveLength(1)
        const arg = capturedSourceCreates[0] as {
            data: {
                id: string
                source: string
                websites: string[]
                status: string
            }
        }
        expect(arg.data.source).toBe('example.com')
        expect(arg.data.websites).toEqual([])
        expect(arg.data.status).toBe('REQUESTED')
        // id is minted app-side (Source.id has no DB default) — a non-empty string.
        expect(typeof arg.data.id).toBe('string')
        expect(arg.data.id.length).toBeGreaterThan(0)
    })
})

describe('listStoreSitemapEntries (app/sitemap.ts read)', () => {
    it('groups VISIBLE sited coupons per raw site with an ::int count and MAX(updated_at), ordered by site, LIMIT-bound', async () => {
        mockRows(
            sql => sql.includes('MAX(updated_at)'),
            [
                {
                    site: 'athleta.gap.com',
                    coupon_count: 7,
                    last_updated: new Date('2026-09-01T00:00:00.000Z'),
                },
                {
                    site: 'gap.com',
                    coupon_count: 30,
                    // A driver handing the timestamp back as a string is
                    // normalized, not treated as drift (z.coerce.date).
                    last_updated: '2026-08-15T00:00:00.000Z',
                },
            ],
        )

        const rows = await listStoreSitemapEntries(5000)

        expect(rows).toEqual([
            {
                site: 'athleta.gap.com',
                coupon_count: 7,
                last_updated: new Date('2026-09-01T00:00:00.000Z'),
            },
            {
                site: 'gap.com',
                coupon_count: 30,
                last_updated: new Date('2026-08-15T00:00:00.000Z'),
            },
        ])

        // Query shape: the shared visibility predicate (the same fragment
        // every listing read inlines), sited rows only, grouped per raw site.
        expect(capturedQueries).toHaveLength(1)
        const q = capturedQueries[0]!
        expect(q).toContain('COUNT(*)::int AS coupon_count')
        expect(q).toContain('MAX(updated_at) AS last_updated')
        expect(q).toContain('expired = FALSE')
        expect(q).toContain('status IN (')
        expect(q).toContain('site IS NOT NULL')
        expect(q).toContain('GROUP BY site')
        expect(q).toContain('ORDER BY site ASC')
        expect(q).toContain('LIMIT ?')
        expect(capturedValues[0]).toContain(5000)
    })

    it('a row missing coupon_count fails the zod boundary loudly (drift, not silent zeros)', async () => {
        mockRows(
            sql => sql.includes('MAX(updated_at)'),
            [{ site: 'gap.com', last_updated: new Date() }],
        )
        await expect(listStoreSitemapEntries(10)).rejects.toThrow(
            /coupons-db schema drift \[sitemap\.stores\]/,
        )
    })
})

describe('store-matching reads bind the LOWERCASE base (site column is stored lowercase)', () => {
    it('listStoreCoupons("eNasco.com") binds enasco.com / %.enasco.com in BOTH the list and the count query', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(0)],
        )

        await listStoreCoupons('eNasco.com', 5)

        expect(capturedValues).toHaveLength(2)
        for (const values of capturedValues) {
            expect(values).toContain('enasco.com')
            expect(values).toContain('%.enasco.com')
            expect(values).not.toContain('eNasco.com')
            expect(values).not.toContain('%.eNasco.com')
        }
        // The predicate itself stays plain, index-friendly equality — no
        // LOWER(site) wrapper that would defeat coupons_site_idx.
        for (const q of capturedQueries) {
            expect(q).toMatch(/\(site = \? OR site LIKE \?\)/)
            expect(q).not.toMatch(/lower\(site\)/i)
        }
    })

    it('listCoupons({ baseSite: "Brooklinen.com" }) binds brooklinen.com', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)'), [{ total: 0 }])

        await listCoupons({ baseSite: 'Brooklinen.com', limit: 10, skip: 0 })

        expect(capturedValues).toHaveLength(2)
        for (const values of capturedValues) {
            expect(values).toContain('brooklinen.com')
            expect(values).toContain('%.brooklinen.com')
            expect(values).not.toContain('Brooklinen.com')
        }
    })
})

// A production-shaped `GROUP BY site` aggregate row (listNeighbourStoreRows).
const aggregateRow = (site: string) => ({
    site,
    coupon_count: 3,
    last_updated: '2026-09-01T00:00:00.000Z',
})

describe('listNeighbourStoreRows — the two raw-slug windows behind "More stores"', () => {
    it('issues one DESC window below and one ASC window above the base, both under the shared visibility predicate, GROUP BY site, bound LIMIT', async () => {
        mockRows(
            sql => sql.includes('site < ?'),
            [aggregateRow('gaomon.com'), aggregateRow('gamestop.com')],
        )
        mockRows(
            sql => sql.includes('site > ?'),
            [aggregateRow('gapfactory.com')],
        )

        const result = await listNeighbourStoreRows('gap.com', 15)

        expect(capturedQueries).toHaveLength(2)
        const [before, after] = capturedQueries as [string, string]
        // Same predicate every listing read uses — a neighbour is always a
        // store with ≥1 visible coupon (i.e. an indexable page).
        for (const q of [before, after]) {
            expect(q).toMatch(/status IN \(\?,\?(,\?)*\) AND expired = FALSE/)
            expect(q).toContain('site IS NOT NULL')
            expect(q).toContain('COUNT(*)::int AS coupon_count')
            expect(q).toContain('MAX(updated_at) AS last_updated')
            expect(q).toContain('GROUP BY site')
            expect(q).toMatch(/LIMIT \?/)
            // Raw-slug comparison on the indexed column — never LOWER(site).
            expect(q).not.toMatch(/lower\(site\)/i)
        }
        expect(before).toContain('site < ?')
        expect(before).toContain('ORDER BY site DESC')
        expect(after).toContain('site > ?')
        expect(after).toContain('ORDER BY site ASC')

        // The base and the limit are bound parameters of BOTH queries.
        for (const values of capturedValues) {
            expect(values).toContain('gap.com')
            expect(values).toContain(15)
        }

        // Rows parse through SiteAggregateRowSchema (Date coercion, ::int).
        expect(result.before.map(r => r.site)).toEqual([
            'gaomon.com',
            'gamestop.com',
        ])
        expect(result.after.map(r => r.site)).toEqual(['gapfactory.com'])
        expect(result.before[0]!.last_updated).toBeInstanceOf(Date)
        expect(result.before[0]!.coupon_count).toBe(3)
    })

    it('a base at either end of the catalog yields an empty window on that side, not an error', async () => {
        mockRows(sql => sql.includes('site > ?'), [aggregateRow('b.com')])
        const result = await listNeighbourStoreRows('a.com', 15)
        expect(result.before).toEqual([])
        expect(result.after.map(r => r.site)).toEqual(['b.com'])
    })
})

describe('listRecentlyWorkedCoupons (landing "Codes that just worked" read)', () => {
    it('joins coupon_signals to VISIBLE sited coupons inside the 24h UTC window, newest apply first, LIMIT-bound — and only SELECTs', async () => {
        mockRows(
            sql => sql.includes('FROM coupon_signals s'),
            [
                {
                    id: 900000017,
                    code: 'LEARN40',
                    site: 'codecademy.com',
                    title: '40% off Pro annual',
                    discount_type: 'percentage',
                    discount_amount: 40,
                    lastWorkedAt: new Date('2026-09-30T11:50:00.000Z'),
                },
                {
                    id: '900000001',
                    code: 'EBAY5',
                    site: 'ebay.com',
                    title: '$5 off',
                    discount_type: null,
                    discount_amount: null,
                    // Driver tolerance: an ISO string normalizes to a Date.
                    lastWorkedAt: '2026-09-30T02:00:00.000Z',
                },
            ],
        )

        const rows = await listRecentlyWorkedCoupons(8)

        expect(rows).toEqual([
            {
                id: '900000017',
                code: 'LEARN40',
                site: 'codecademy.com',
                title: '40% off Pro annual',
                discount_type: 'PERCENTAGE',
                discount_amount: 40,
                lastWorkedAt: new Date('2026-09-30T11:50:00.000Z'),
            },
            {
                id: '900000001',
                code: 'EBAY5',
                site: 'ebay.com',
                title: '$5 off',
                discount_type: null,
                discount_amount: null,
                lastWorkedAt: new Date('2026-09-30T02:00:00.000Z'),
            },
        ])

        expect(capturedQueries).toHaveLength(1)
        const q = capturedQueries[0]!
        // Read-only: a SELECT over the join, never a write to either table.
        expect(q.trim().startsWith('SELECT')).toBe(true)
        expect(q).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/)
        expect(q).toContain('FROM coupon_signals s')
        expect(q).toContain('JOIN coupons c ON c.id = s.coupon_id')
        // The window: coupons.ts's 24h constant, compared as UTC wall-clock
        // time against the timestamp-without-time-zone column.
        expect(q).toContain(
            "s.last_worked_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'",
        )
        // The shared visibility predicate (same fragment every listing inlines).
        expect(q).toMatch(/status IN \(\?(?:,\?)*\) AND expired = FALSE/)
        // Restricted (amber) codes never feature: every tile renders Verified.
        expect(q).toMatch(/c\.status NOT IN \(\?(?:,\?)*\)/)
        for (const status of RESTRICTED_COUPON_STATUSES) {
            expect(capturedValues[0]).toContain(status)
        }
        expect(q).toContain('c.site IS NOT NULL')
        expect(q).toContain('ORDER BY s.last_worked_at DESC, s.coupon_id DESC')
        expect(q).toContain('LIMIT ?')
        expect(capturedValues[0]).toContain(8)
    })

    it('a row missing lastWorkedAt fails the zod boundary loudly (drift, not a silent undated tile)', async () => {
        mockRows(
            sql => sql.includes('FROM coupon_signals s'),
            [
                {
                    id: '1',
                    code: 'X',
                    site: 'example.com',
                    title: 'X',
                    discount_type: null,
                    discount_amount: null,
                },
            ],
        )
        await expect(listRecentlyWorkedCoupons(8)).rejects.toThrow(
            /coupons-db schema drift \[coupons\.recently-worked\]/,
        )
    })
})

// Matchers over the composed SQL of each statement submitShopperCoupon issues.
const isDedupe = (sql: string) => sql.includes('lower(code) = lower(')
const isCap = (sql: string) => sql.includes('submitted_by_user_id = ')
const isInsert = (sql: string) => sql.includes('INSERT INTO coupons')
const isLock = (sql: string) => sql.includes('pg_advisory_xact_lock')

describe('submitShopperCoupon (THIRD sanctioned write: shopper-submitted codes)', () => {
    const INSERTED_ID = '900000000000000007'
    const ARGS = {
        base: 'Ebay.com',
        code: 'SaVe10',
        source: 'manual' as const,
        userId: 'user-uuid-1',
    }

    function queryIndex(match: (sql: string) => boolean) {
        return capturedQueries.findIndex(match)
    }

    it('(a) dedupes case-insensitively on the code, with the store page predicate AND visibility rule', async () => {
        mockRows(isInsert, [{ id: INSERTED_ID }])
        mockRows(isCap, [{ total: 0 }])

        await submitShopperCoupon(ARGS)

        const i = queryIndex(isDedupe)
        expect(i).toBeGreaterThanOrEqual(0)
        const sql = capturedQueries[i] ?? ''
        expect(sql).toContain('lower(code) = lower(')
        // The store page's own predicate (siteBaseMatchSql), not a re-written one.
        expect(sql).toContain('(site = ? OR site LIKE ?)')
        // The store page's own visibility rule (visibleCouponsWhere): a code
        // the page would NOT show (invalid/expired status) is not "already listed".
        expect(sql).toContain('status IN (')
        expect(sql).toContain('expired = FALSE')
        // Bound: the code as typed, the LOWERCASE base twice (equality +
        // suffix), then the visible-status list.
        expect(capturedValues[i]).toEqual([
            'SaVe10',
            'ebay.com',
            '%.ebay.com',
            ...VISIBLE_COUPON_STATUSES,
        ])
        expect(capturedValues[i]).not.toContain('invalid')
    })

    it('(b) returns the existing row and inserts nothing when the code is already listed', async () => {
        mockRows(isDedupe, [{ id: '812345' }])

        await expect(submitShopperCoupon(ARGS)).resolves.toEqual({
            couponId: '812345',
            created: false,
        })
        expect(capturedQueries.some(isInsert)).toBe(false)
        // A duplicate is a hit, not a new submission: it must not burn the
        // shopper's daily allowance, so the cap is never even counted.
        expect(capturedQueries.some(isCap)).toBe(false)
    })

    it("(c) counts the shopper's submissions in the last 24h and throws ShopperSubmissionLimitError at the cap", async () => {
        mockRows(isCap, [{ total: SHOPPER_DAILY_SUBMISSION_CAP }])

        await expect(submitShopperCoupon(ARGS)).rejects.toBeInstanceOf(
            ShopperSubmissionLimitError,
        )
        expect(capturedQueries.some(isInsert)).toBe(false)

        const i = queryIndex(isCap)
        const sql = capturedQueries[i] ?? ''
        expect(sql).toContain('submitted_by_user_id = ?')
        expect(sql).toContain("created_at > (NOW() AT TIME ZONE 'UTC')")
        expect(sql).toContain("INTERVAL '24 hours'")
        expect(capturedValues[i]).toEqual(['user-uuid-1'])
    })

    it('(c) one below the cap still inserts', async () => {
        mockRows(isCap, [{ total: SHOPPER_DAILY_SUBMISSION_CAP - 1 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        await expect(submitShopperCoupon(ARGS)).resolves.toEqual({
            couponId: INSERTED_ID,
            created: true,
        })
    })

    it('(d) INSERTs a pending, unexpired row whose id comes from the reserved sequence', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        const result = await submitShopperCoupon(ARGS)

        expect(result).toEqual({ couponId: INSERTED_ID, created: true })
        const i = queryIndex(isInsert)
        const sql = capturedQueries[i] ?? ''
        expect(sql).toContain("nextval('shopper_coupon_id_seq')::text")
        expect(sql).toContain('RETURNING id')
        // Fixed literals live in the SQL text, not in bound values.
        expect(sql).toContain("'pending'")
        expect(sql).toContain('FALSE')
        expect(sql).toContain("(NOW() AT TIME ZONE 'UTC')")
        // Bound values, in column order: code as typed (case preserved), the
        // lowercase base, the empty title (shopperCouponTitle derives one at
        // read time), the description, then the attribution pair.
        expect(capturedValues[i]).toEqual([
            'SaVe10',
            'ebay.com',
            '',
            SHOPPER_COUPON_DESCRIPTION,
            'user-uuid-1',
            'manual',
        ])
    })

    it('(e) runs the lock, dedupe and insert in ONE transaction, lock first', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        await submitShopperCoupon(ARGS)

        expect(transactionCount).toBe(1)
        const lock = queryIndex(isLock)
        expect(lock).toBeGreaterThanOrEqual(0)
        // Locks first, then check, then write: that order is what makes two
        // concurrent submits of one code produce one row.
        expect(lock).toBeLessThan(queryIndex(isDedupe))
        expect(queryIndex(isDedupe)).toBeLessThan(queryIndex(isCap))
        expect(queryIndex(isCap)).toBeLessThan(queryIndex(isInsert))
    })

    it('takes the per-user lock BEFORE the code lock (fixed order), each in its own two-int class', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        await submitShopperCoupon(ARGS)

        const locks = capturedQueries
            .map((sql, i) => ({ sql, values: capturedValues[i] }))
            .filter(q => isLock(q.sql))
        expect(locks).toHaveLength(2)
        for (const lock of locks) {
            expect(lock.sql).toContain(
                'pg_advisory_xact_lock(?::int, hashtext(',
            )
        }
        // [class, key]: user lock first (key = user id), then the code lock
        // (key = lowercase base + ':' + lowercase code, so case variants share it).
        expect(locks[0]?.values).toEqual([7101, 'user-uuid-1'])
        expect(locks[1]?.values).toEqual([7102, 'ebay.com:save10'])
        // And both precede the daily-cap count they protect.
        expect(queryIndex(isCap)).toBeGreaterThan(
            capturedQueries.lastIndexOf(locks[1]?.sql ?? ''),
        )
    })

    it.each([
        ['empty', ''],
        ['too short', 'ab'],
        ['inner space', 'a b c'],
        ['markup', '<script>'],
        ['41 characters', 'a'.repeat(41)],
    ])(
        'rejects an invalid code (%s) with a plain Error before any SQL',
        async (_label, code) => {
            await expect(
                submitShopperCoupon({ ...ARGS, code }),
            ).rejects.toThrow('invalid shopper code')
            expect(transactionCount).toBe(0)
            expect(capturedQueries).toHaveLength(0)
        },
    )

    it('trims the code before storing it (the repo normalizes, not just the caller)', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        await submitShopperCoupon({ ...ARGS, code: '  SaVe10 ' })

        expect(capturedValues[queryIndex(isInsert)]?.[0]).toBe('SaVe10')
    })

    it.each([
        ['LIKE wildcard %', 'ebay%.com'],
        ['LIKE wildcard _', 'eb_y.com'],
        ['space', 'ebay .com'],
        ['path', 'ebay.com/x'],
        ['scheme', 'https://ebay.com'],
        ['empty', ''],
    ])(
        'rejects a base that is not a clean hostname (%s) before any SQL',
        async (_label, base) => {
            await expect(
                submitShopperCoupon({ ...ARGS, base }),
            ).rejects.toThrow(/invalid store base/)
            expect(transactionCount).toBe(0)
            expect(capturedQueries).toHaveLength(0)
        },
    )

    it('a missing daily-count row is a loud error, never "zero submissions"', async () => {
        mockRows(isCap, [])

        await expect(submitShopperCoupon(ARGS)).rejects.toThrow(
            /daily-count query returned no row/,
        )
        expect(capturedQueries.some(isInsert)).toBe(false)
    })

    it('records a checkout capture with source=checkout', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [{ id: INSERTED_ID }])

        await submitShopperCoupon({ ...ARGS, source: 'checkout' })

        const values = capturedValues[queryIndex(isInsert)] ?? []
        expect(values[values.length - 1]).toBe('checkout')
    })

    it('an INSERT that returns no row is a loud error, never a silent created:true', async () => {
        mockRows(isCap, [{ total: 0 }])
        mockRows(isInsert, [])

        await expect(submitShopperCoupon(ARGS)).rejects.toThrow(
            /submitShopperCoupon/,
        )
    })
})
