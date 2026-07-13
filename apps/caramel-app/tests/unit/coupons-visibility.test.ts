import { GET as filtersGET } from '@/app/api/coupons/filters/route'
import { GET as couponsGET } from '@/app/api/coupons/route'
import { GET as statsGET } from '@/app/api/coupons/stats/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Characterization pins (F-004) — originally pinned the CURRENT
// (already-drifted) coupon visibility predicate each route composed.
// F-006 unified all three onto couponsDb.ts's visibleCouponsWhere() /
// verifiedCensusSql() fragment factories; these pins now assert the
// UNIFIED state (updated per PLAN-F-006.md's "per-site drift ruling"
// table — filters/route.ts's behavior change is deliberate and flagged
// there; stats/route.ts's predicate is unchanged, only its SQL *shape*
// changed).
//
// couponsDb.ts throws at import time when COUPONS_DATABASE_URL is unset
// (no coupons DB in unit/CI), so couponsSql is mocked via a factory (never
// loads the real module) as a recording tagged-template spy: it records
// `strings.join('?')` (text) and the raw interpolated `values` per call,
// and every call resolves to `[]`.
//
// F-006 nuance discovered writing this pin: visibleCouponsWhere() /
// rankingOrderSql() / verifiedCensusSql() are copied onto the mock's
// returned object via `...actual` (vi.importActual), but each one's OWN
// function body still closes over the REAL couponsDb.ts module's REAL
// couponsSql binding — a JS closure resolves a free variable through its
// DEFINING module's scope, not through whatever object some OTHER module
// (this mock) later assembles. So calling `visibleCouponsWhere()` from a
// route under test does NOT run through this mock at all: it builds a
// REAL postgres.js fragment (safe — postgres.js only opens a socket on
// first *execution*, and this fragment is only ever passed along as a
// value, never awaited). Only the route's own OUTER couponsSql`` call
// (written directly in the route file, so it resolves the MOCKED
// couponsSql) is observed by this mock — and it receives that real
// fragment as one of its interpolated `values`. So proving "this route
// uses the shared fragment" means inspecting the CAPTURED VALUE's own
// `.strings`/`.args` (same technique as coupons-sql.test.ts), not
// string-matching `calls` for the fragment's inner SQL text.
const calls: string[] = []
const callValues: unknown[][] = []

// F-001 — re-export the REAL schemas/parseCouponRows via importActual and
// only replace couponsSql itself: the routes under test now import
// parseCouponRows + the row schemas from this module too, and a factory
// that provided just `{ couponsSql }` would leave those undefined,
// breaking every route with a TypeError before it ever reaches its SQL
// mock (parseCouponRows is not a function). An empty-array result parses
// through any of the real schemas trivially, so this stays a true
// characterization of unchanged behavior.
vi.mock('@/lib/couponsDb', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/couponsDb')>(
            '@/lib/couponsDb',
        )
    return {
        ...actual,
        couponsSql: (strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push(strings.join('?'))
            callValues.push(values)
            // Deliberate thenable mock — replicates the shape `postgres`
            // tagged templates return so `await couponsSql\`...\`` resolves
            // in the routes under test. The property MUST be named `then`
            // for that to work.
            // oxlint-disable-next-line no-thenable
            return { then: (resolve: (rows: unknown[]) => void) => resolve([]) }
        },
    }
})

vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
}))

beforeEach(() => {
    calls.length = 0
    callValues.length = 0
})

// Duck-types a captured interpolated value as a real postgres.js query
// fragment (Query extends Promise, so `typeof === 'object'`) and compares
// its flattened literal text — the same `.strings`/`.args` surface
// coupons-sql.test.ts pins directly, reused here to identify WHICH
// fragment a route interpolated without re-deriving postgres.js's
// internal Builder/IN-list serialization.
function fragmentText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const strings = (value as { strings?: unknown }).strings
    if (!Array.isArray(strings)) return undefined
    return strings.join('')
}

function includesFragment(values: unknown[][], text: string): boolean {
    return values.some(vs => vs.some(v => fragmentText(v) === text))
}

const VISIBLE_WHERE_TEXT = 'status IN  AND expired = FALSE'
const RANKING_ORDER_TEXT = 'rating DESC, created_at DESC'
const VERIFIED_CENSUS_TEXT = "status = 'valid'"

describe('coupon visibility predicates (route-composed SQL, F-006 unified)', () => {
    it('coupons/route.ts: WHERE + ORDER BY are interpolated (not baked-in literals), and the interpolated values are exactly visibleCouponsWhere() / rankingOrderSql()', async () => {
        const res = await couponsGET(
            new NextRequest('http://localhost/api/coupons'),
        )

        expect(res.status).toBe(200)
        expect(
            calls.some(s => s.includes('WHERE ?') && s.includes('ORDER BY ?')),
        ).toBe(true)
        expect(includesFragment(callValues, VISIBLE_WHERE_TEXT)).toBe(true)
        expect(includesFragment(callValues, RANKING_ORDER_TEXT)).toBe(true)
    })

    it("filters/route.ts: UNIFIED to visibleCouponsWhere() — deliberate behavior change (was 'valid'-only, now the full visible set; F-006, flagged)", async () => {
        const res = await filtersGET(
            new NextRequest('http://localhost/api/coupons/filters'),
        )

        expect(res.status).toBe(200)
        // Both queries (sites + discountTypes) route through an
        // interpolated WHERE now — no more literal `status = 'valid'`
        // baked directly into either query's own text.
        expect(
            calls.some(s => s.includes('WHERE ? AND site IS NOT NULL')),
        ).toBe(true)
        expect(
            calls.some(s =>
                s.includes('WHERE ? AND discount_type IS NOT NULL'),
            ),
        ).toBe(true)
        // The interpolated fragment itself is visibleCouponsWhere() — the
        // actual proof of unification (byte-identical to every other
        // unified route's, not just similar-looking code) — and it was
        // built twice (once per query).
        const occurrences = callValues.filter(vs =>
            vs.some(v => fragmentText(v) === VISIBLE_WHERE_TEXT),
        ).length
        expect(occurrences).toBe(2)
    })

    it("stats/route.ts: verifiedCensusSql() — 'valid'-only, no expired filter (F-006 ruling: predicate UNCHANGED, only its SQL shape changed — see note)", async () => {
        const res = await statsGET(
            new NextRequest('http://localhost/api/coupons/stats'),
        )

        expect(res.status).toBe(200)
        // Shape change (documented, not a behavior change): pre-F-006 the
        // whole SELECT was one literal template with `status = 'valid'`
        // baked directly into its own text ("WHERE status = 'valid'" was
        // asserted here directly). verifiedCensusSql() now composes as a
        // nested fragment (`WHERE ${verifiedCensusSql()}`), so the outer
        // SELECT's own recorded text shows a bare `?` where that literal
        // used to sit — the literal itself is unchanged, just carried as
        // the interpolated value instead (asserted below via
        // includesFragment). Same SQL sent to Postgres either way; only
        // how this mock observes it changed.
        const statsCall = calls.find(s => s.includes('COUNT(*)'))
        expect(statsCall).toContain('WHERE ?')
        expect(statsCall).not.toContain('expired = FALSE')
        expect(includesFragment(callValues, VERIFIED_CENSUS_TEXT)).toBe(true)
    })
})
