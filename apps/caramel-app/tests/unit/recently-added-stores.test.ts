import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import { listRecentlyAddedStores } from '@/lib/couponsRepo'
import { formatStoreAddedLabel } from '@/lib/recentStores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins for the /supported-stores "Recently added" strip.
//
// The load-bearing claim this file protects is the COLUMN CHOICE. "Recently
// added" is only meaningful because it reads `store_configs.created_at`:
// measured on prod, 18,311 coupon rows across 1,013 sites share the single
// instant 2026-05-13 01:40:42.656 (the catalog seed import), so the obvious
// alternative — MIN(coupons.created_at) per site — would date a third of the
// catalog to one meaningless moment and the strip would be decoration. Zero
// store_configs rows sit at that instant. A future edit that "simplifies" this
// query onto a coupons timestamp reinstates exactly that, silently and with
// every other test still green, so the query shape is asserted directly.
//
// Same mocking contract as couponsRepo.test.ts: `@/lib/prisma` is stubbed and
// `$queryRaw` records the composed `.sql` (nested fragments inlined, bound
// values as `?`) while returning rule-matched rows. parseCouponRows and the
// real RecentStoreRowSchema come from the UNMOCKED couponsDb, so these tests
// exercise the actual read boundary.
type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
let capturedQueries: string[] = []

function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            capturedQueries.push(arg.sql)
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
    },
}))

beforeEach(() => {
    rules = []
    capturedQueries = []
})

/** The shape prod returns: a JS Date for the `timestamp(3)` column. */
const storeRowFixture = {
    store_name: 'fnp.com',
    added_at: new Date('2026-08-18T13:56:39.192Z'),
}

describe('listRecentlyAddedStores — query shape', () => {
    it('ranks by the store config’s own created_at, newest first', async () => {
        mockRows(() => true, [storeRowFixture])

        await listRecentlyAddedStores(4)

        const sql = capturedQueries[0]
        expect(sql).toContain('FROM store_configs')
        expect(sql).toMatch(/ORDER BY\s+sc\.created_at DESC/)
    })

    it('never ranks by a coupons timestamp (the bulk-import trap)', async () => {
        mockRows(() => true, [])

        await listRecentlyAddedStores(4)

        const sql = capturedQueries[0]
        // The coupons table may only ever be REFERENCED as an existence gate
        // here. Any aggregate over its created_at, or an ORDER BY reaching
        // into it, means the ranking moved onto the seeded column.
        expect(sql).not.toMatch(/MIN\s*\(\s*c?\.?created_at/i)
        expect(sql).not.toMatch(/ORDER BY[^)]*\bc\.created_at/i)
    })

    it('only offers stores that have visible coupons, using the shared predicate', async () => {
        mockRows(() => true, [])

        await listRecentlyAddedStores(4)

        const sql = capturedQueries[0]
        // The EXISTS gate keeps the strip in step with the page's own store
        // universe: every tile links to /coupons/<site>, so a store with no
        // visible coupons would be a tile that promises coupons and delivers
        // an empty page.
        expect(sql).toMatch(/EXISTS\s*\(/i)
        expect(sql).toContain('c.site = sc.store_name')
        // Same visibility definition as every other listing read — the
        // fragment expands to one `?` per status plus the expired guard.
        expect(sql).toContain('expired = FALSE')
        expect(sql).toContain(
            `status IN (${VISIBLE_COUPON_STATUSES.map(() => '?').join(',')})`,
        )
    })

    it('binds the caller’s limit rather than inlining a literal', async () => {
        mockRows(() => true, [])

        await listRecentlyAddedStores(4)

        expect(capturedQueries[0]).toMatch(/LIMIT\s+\?/)
    })
})

describe('listRecentlyAddedStores — read boundary', () => {
    it('returns the parsed rows with added_at as a Date', async () => {
        mockRows(() => true, [storeRowFixture])

        const rows = await listRecentlyAddedStores(4)

        expect(rows).toEqual([
            {
                store_name: 'fnp.com',
                added_at: new Date('2026-08-18T13:56:39.192Z'),
            },
        ])
        expect(rows[0].added_at).toBeInstanceOf(Date)
    })

    it('coerces an ISO-string timestamp rather than throwing', async () => {
        // A driver handing back the same column as a string is a shape this
        // boundary can normalize, not a drift worth 500ing the page over.
        mockRows(
            () => true,
            [{ store_name: 'fnp.com', added_at: '2026-08-18T13:56:39.192Z' }],
        )

        const rows = await listRecentlyAddedStores(4)

        expect(rows[0].added_at).toEqual(new Date('2026-08-18T13:56:39.192Z'))
    })

    it('throws loudly when a column goes missing (drift, not a silent empty strip)', async () => {
        mockRows(() => true, [{ store_name: 'fnp.com' }])

        await expect(listRecentlyAddedStores(4)).rejects.toThrow(
            /schema drift \[sites\.recently-added\]/,
        )
    })

    it('an empty catalog is legitimate, not drift', async () => {
        mockRows(() => true, [])

        await expect(listRecentlyAddedStores(4)).resolves.toEqual([])
    })
})

describe('formatStoreAddedLabel', () => {
    const now = new Date('2026-08-20T12:00:00.000Z')
    const at = (iso: string) => formatStoreAddedLabel(new Date(iso), now)

    it('reads the same day as today', () => {
        expect(at('2026-08-20T00:05:00.000Z')).toBe('Added today')
    })

    it('counts CALENDAR days, so late last night is yesterday and not today', () => {
        // Two hours elapsed, one calendar day crossed. Flooring elapsed time
        // would call this "today", which reads as wrong to anyone who saw the
        // store appear overnight.
        expect(
            formatStoreAddedLabel(
                new Date('2026-08-20T23:00:00.000Z'),
                new Date('2026-08-21T01:00:00.000Z'),
            ),
        ).toBe('Added yesterday')
    })

    it('names the day count up to a fortnight', () => {
        expect(at('2026-08-15T13:00:00.000Z')).toBe('Added 5 days ago')
        expect(at('2026-08-07T13:00:00.000Z')).toBe('Added 13 days ago')
    })

    it('switches to weeks, singular at exactly two', () => {
        expect(at('2026-08-06T13:00:00.000Z')).toBe('Added 2 weeks ago')
        expect(at('2026-07-23T13:00:00.000Z')).toBe('Added 4 weeks ago')
    })

    it('switches to months past two, and never hides a stale date', () => {
        // The strip is honest about a pipeline that has stopped adding stores
        // — a permanent "New" badge over months-old coverage is the failure
        // this section exists to prevent.
        expect(at('2026-06-01T13:00:00.000Z')).toBe('Added 2 months ago')
        expect(at('2026-02-01T13:00:00.000Z')).toBe('Added 6 months ago')
    })

    it('reads a future timestamp as today rather than a negative count', () => {
        // Clock skew between the pipeline that stamped the row and the web
        // server reading it. "Added -1 days ago" is worse than a day of
        // imprecision.
        expect(at('2026-08-25T12:00:00.000Z')).toBe('Added today')
    })
})
