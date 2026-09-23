import {
    expireCoupons,
    getCouponStats,
    listCoupons,
    listNeighbourStoreRows,
    listStoreCoupons,
    listStoreSitemapEntries,
    requestSource,
} from '@/lib/couponsRepo'
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
// The bound parameter VALUES of every $queryRaw, in the same order — lets a
// test assert on what was actually bound (e.g. the lowercased store base).
let capturedValues: unknown[][] = []
// Affected-row count the mocked $executeRaw returns (expire).
let executeRawResult = 0
// Args every prisma.source.create() was called with (requestSource).
let capturedSourceCreates: unknown[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

// prisma.$queryRaw / $executeRaw receive a Prisma.Sql whose `.sql` getter is the
// composed, flattened query text (nested fragments inlined, values as `?`).
vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string; values: unknown[] }) => {
            capturedQueries.push(arg.sql)
            capturedValues.push(arg.values)
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
        $executeRaw: (arg: { sql: string }) => {
            capturedQueries.push(arg.sql)
            return Promise.resolve(executeRawResult)
        },
        couponSignal: { findMany: vi.fn(async () => []) },
        source: {
            create: (arg: unknown) => {
                capturedSourceCreates.push(arg)
                return Promise.resolve({})
            },
        },
    },
}))

beforeEach(() => {
    rules = []
    capturedQueries = []
    capturedValues = []
    executeRawResult = 0
    capturedSourceCreates = []
})

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
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 0 }])

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
