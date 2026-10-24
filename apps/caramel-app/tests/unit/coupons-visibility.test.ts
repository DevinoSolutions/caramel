import { GET as filtersGET } from '@/app/api/coupons/filters/route'
import { GET as couponsGET } from '@/app/api/coupons/route'
import { GET as statsGET } from '@/app/api/coupons/stats/route'
import { resetAnonymousReadCaches } from '@/lib/anonymousReadCaches'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Characterization pins (F-004/F-006) for the coupon visibility predicates
// each read composes. F-006 unified all three routes onto the shared
// visibleCouponsWhere() / verifiedCensusSql() fragments; these pins assert the
// UNIFIED state (filters/route.ts's behavior change is deliberate and flagged
// in PLAN-F-006.md; stats/route.ts's predicate is unchanged).
//
// W4 — the reads run on the app's Prisma catalog via
// `prisma.$queryRaw(Prisma.sql`...`)`. Unlike the pre-W4 porsager fragments
// (which composed as nested objects the mock had to inspect by value), a
// Prisma.sql fragment nested into a parent template is INLINED into the
// parent's composed `.sql` (flattened `?`-placeholder text) — so proving "this
// route uses the shared predicate" is a direct string match on the captured
// `.sql`, no fragment-object duck-typing needed. `@/lib/prisma` is mocked to
// record every composed query and resolve to `[]`.
let capturedQueries: string[] = []

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            capturedQueries.push(arg.sql)
            return Promise.resolve([])
        },
        couponSignal: { findMany: vi.fn(async () => []) },
    },
}))

vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
}))

beforeEach(() => {
    resetAnonymousReadCaches()
    capturedQueries = []
})

// visibleCouponsWhere() composes to `status IN (?,?,...) AND expired = FALSE`
// (one `?` per VISIBLE_COUPON_STATUSES entry, parameterized). Matched by shape
// so the pin doesn't hard-code the status count.
const VISIBLE_WHERE_RE = /status IN \(\?(?:,\?)*\) AND expired = FALSE/
const RANKING_ORDER_TEXT = 'rating DESC, created_at DESC'
const VERIFIED_CENSUS_TEXT = "status = 'valid'"

describe('coupon visibility predicates (composed Prisma SQL, F-006 unified)', () => {
    it('coupons/route.ts: the list + count queries both compose visibleCouponsWhere(), and the list adds rankingOrderSql()', async () => {
        const res = await couponsGET(
            new NextRequest('http://localhost/api/coupons'),
        )

        expect(res.status).toBe(200)
        const listQuery = capturedQueries.find(
            q => q.includes('FROM coupons') && q.includes('LIMIT'),
        )
        expect(listQuery).toBeDefined()
        expect(listQuery).toMatch(VISIBLE_WHERE_RE)
        expect(listQuery).toContain(RANKING_ORDER_TEXT)

        const countQuery = capturedQueries.find(
            q => q.includes('COUNT(*)') && !q.includes('LIMIT'),
        )
        expect(countQuery).toBeDefined()
        expect(countQuery).toMatch(VISIBLE_WHERE_RE)
    })

    it("filters/route.ts: UNIFIED to visibleCouponsWhere() — deliberate behavior change (was 'valid'-only, now the full visible set; F-006, flagged), built once per query", async () => {
        const res = await filtersGET(
            new NextRequest('http://localhost/api/coupons/filters'),
        )

        expect(res.status).toBe(200)
        const sitesQuery = capturedQueries.find(
            q => q.includes('DISTINCT site') && q.includes('IS NOT NULL'),
        )
        expect(sitesQuery).toMatch(VISIBLE_WHERE_RE)
        const typesQuery = capturedQueries.find(q =>
            q.includes('DISTINCT discount_type'),
        )
        expect(typesQuery).toMatch(VISIBLE_WHERE_RE)
        // Composed twice (once per query) — the proof of unification, not just
        // similar-looking code.
        const occurrences = capturedQueries.filter(q =>
            VISIBLE_WHERE_RE.test(q),
        ).length
        expect(occurrences).toBe(2)
    })

    it("stats/route.ts: verifiedCensusSql() — 'valid'-only, no expired filter (F-006 ruling: predicate UNCHANGED — NOT the visibility predicate)", async () => {
        const res = await statsGET(
            new NextRequest('http://localhost/api/coupons/stats'),
        )

        expect(res.status).toBe(200)
        const statsQuery = capturedQueries.find(q => q.includes('COUNT(*)'))
        expect(statsQuery).toContain(VERIFIED_CENSUS_TEXT)
        // The census deliberately differs from the visibility predicate: it
        // must INCLUDE expired 'valid' rows (to count them), so it carries no
        // `expired = FALSE` and is not `status IN (...) AND expired = FALSE`.
        expect(statsQuery).not.toContain('expired = FALSE')
        expect(statsQuery).not.toMatch(VISIBLE_WHERE_RE)
    })
})
