import { GET as couponsGET } from '@/app/api/coupons/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The paging contract of /api/coupons, written when the extension popup started
// consuming it (2026-08-10). The popup previously asked for 20 codes and showed
// whatever came back — eBay held 96 — so the popup now walks pages, and this
// route is what it walks.
//
// The route already accepted `page`/`limit` and already answered with a
// `page/limit/total/hasMore` envelope. That is precisely why the FIRST thing
// here is a characterization of the un-paginated call: a shipped extension, the
// SSR site and the toolbar badge all call this route without paging params, and
// none of them may notice that a new consumer arrived. Everything after that
// pins the paging behavior the popup now depends on.
//
// `@/lib/prisma` is mocked as a recording resolver keyed on the composed `.sql`
// (the coupons-read-boundary.test.ts pattern), with the bound VALUES captured
// too — LIMIT/OFFSET are parameters, so the values array is where the offset
// arithmetic is actually visible.

type Captured = { sql: string; values: unknown[] }
let capturedQueries: Captured[] = []
let catalogRows: unknown[] = []
let totalRows: unknown[] = []

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string; values: unknown[] }) => {
            capturedQueries.push({ sql: arg.sql, values: arg.values })
            const isCount =
                arg.sql.includes('COUNT(*)') && !arg.sql.includes('LIMIT')
            return Promise.resolve(isCount ? totalRows : catalogRows)
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

/** One production-shaped catalog row (numeric columns arrive as strings). */
function row(n: number) {
    return {
        id: String(n),
        code: `SAVE${n}`,
        site: 'ebay.com',
        title: `Deal ${n}`,
        description: `Description ${n}`,
        rating: '4.5',
        discount_type: 'PERCENTAGE',
        discount_amount: '10',
        expiry: null,
        expired: false,
        timesUsed: 3,
        status: 'valid',
        verificationMessage: null,
    }
}

const CATALOG_TOTAL = 96

function serve(rows: number[], total = CATALOG_TOTAL) {
    catalogRows = rows.map(row)
    totalRows = [{ total }]
}

async function call(query: string) {
    const res = await couponsGET(
        new NextRequest(`http://localhost/api/coupons${query}`),
    )
    return { res, body: await res.json() }
}

/** The list query (the one carrying LIMIT/OFFSET), not the count query. */
function listQuery() {
    const q = capturedQueries.find(
        c => c.sql.includes('FROM coupons') && c.sql.includes('LIMIT'),
    )
    expect(q, 'the route issued a list query').toBeDefined()
    return q!
}

/** LIMIT and OFFSET are the last two bound parameters of the list query. */
function limitAndOffset() {
    const { values } = listQuery()
    return {
        limit: values[values.length - 2],
        offset: values[values.length - 1],
    }
}

beforeEach(() => {
    capturedQueries = []
    serve([1, 2, 3])
})

describe('/api/coupons — the un-paginated call is UNCHANGED (characterization)', () => {
    it('a bare GET still answers the exact same envelope: page 1, limit 10, total, hasMore, coupons', async () => {
        serve([1, 2, 3], 3)
        const { res, body } = await call('')

        expect(res.status).toBe(200)
        // Byte-for-byte: the key set, the values, and nothing new.
        expect(Object.keys(body).sort()).toEqual([
            'coupons',
            'hasMore',
            'limit',
            'page',
            'total',
        ])
        expect(body.page).toBe(1)
        expect(body.limit).toBe(10)
        expect(body.total).toBe(3)
        expect(body.hasMore).toBe(false)
        expect(body.coupons).toHaveLength(3)
        expect(body.coupons[0]).toMatchObject({
            id: '1',
            code: 'SAVE1',
            site: 'ebay.com',
            rating: 4.5,
            lastWorkedAt: null,
        })
    })

    it('still defaults to LIMIT 10 OFFSET 0 and the 60s edge cache', async () => {
        const { res } = await call('')

        expect(limitAndOffset()).toEqual({ limit: 10, offset: 0 })
        expect(res.headers.get('Cache-Control')).toBe(
            'public, s-maxage=60, stale-while-revalidate=60',
        )
    })

    it("the extension's own un-paginated call (site + key_words + limit=20) is untouched", async () => {
        // This is the request every SHIPPED extension makes, verbatim.
        const { res, body } = await call('?site=ebay.com&key_words=&limit=20')

        expect(res.status).toBe(200)
        expect(limitAndOffset()).toEqual({ limit: 20, offset: 0 })
        expect(body.page).toBe(1)
        expect(body.limit).toBe(20)
    })
})

describe('/api/coupons — paging', () => {
    it('page N asks the catalog for the right window and reports it back', async () => {
        serve([21, 22, 23])
        const { body } = await call('?site=ebay.com&limit=20&page=2')

        expect(limitAndOffset()).toEqual({ limit: 20, offset: 20 })
        expect(body.page).toBe(2)
        expect(body.limit).toBe(20)
        expect(body.coupons.map((c: { code: string }) => c.code)).toEqual([
            'SAVE21',
            'SAVE22',
            'SAVE23',
        ])
    })

    it('hasMore is true while the window ends before the total, and false on the last page', async () => {
        // Positive precondition first: a middle page really does report more.
        serve(
            Array.from({ length: 20 }, (_, i) => i + 21),
            96,
        )
        const middle = await call('?site=ebay.com&limit=20&page=2')
        expect(middle.body.hasMore).toBe(true)
        expect(middle.body.total).toBe(96)

        capturedQueries = []
        // Last page: offset 80 + 16 rows = 96, exactly the total.
        serve(
            Array.from({ length: 16 }, (_, i) => i + 81),
            96,
        )
        const last = await call('?site=ebay.com&limit=20&page=5')
        expect(last.body.coupons).toHaveLength(16)
        expect(last.body.hasMore).toBe(false)
    })

    it('an offset past the end is an empty last page, not an error', async () => {
        serve([], 96)
        const { res, body } = await call('?site=ebay.com&limit=20&page=99')

        expect(res.status).toBe(200)
        expect(body.coupons).toEqual([])
        expect(body.total).toBe(96)
        expect(body.hasMore).toBe(false)
        expect(limitAndOffset()).toEqual({ limit: 20, offset: 20 * 98 })
    })
})

describe('/api/coupons — the caps a client cannot talk past', () => {
    it('limit is capped at 50 however large the caller asks', async () => {
        await call('?limit=5000')
        expect(limitAndOffset().limit).toBe(50)
    })

    it.each([
        ['?limit=0', 10],
        ['?limit=-5', 10],
        ['?limit=abc', 10],
        ['?limit=', 10],
        ['?limit=25', 25],
    ])('limit %s resolves to %i', async (query, expected) => {
        await call(query)
        expect(limitAndOffset().limit).toBe(expected)
    })

    it('page is capped at 500, so the catalog cannot be walked indefinitely', async () => {
        await call('?limit=50&page=999999')
        expect(limitAndOffset().offset).toBe(50 * 499)
    })

    it.each([
        ['?page=0', 0],
        ['?page=-3', 0],
        ['?page=abc', 0],
        ['?page=3', 20],
    ])('page %s resolves to offset %i at limit 10', async (query, offset) => {
        await call(`${query}&limit=10`)
        expect(limitAndOffset().offset).toBe(offset)
    })
})

describe('/api/coupons — the sort that makes paging sound', () => {
    it('orders by a TOTAL order: the ranking, then the primary key as tiebreaker', async () => {
        await call('?site=ebay.com&limit=20&page=2')

        // Without the id tiebreaker, `rating DESC, created_at DESC` leaves tied
        // rows in an order Postgres may choose differently per query — and two
        // pages are two queries, so a tied row can be served twice or never.
        // The second case is the dangerous one: no client-side dedupe can see a
        // row that was never sent.
        expect(listQuery().sql).toContain(
            'ORDER BY rating DESC, created_at DESC, id DESC',
        )
    })
})
