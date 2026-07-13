import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import {
    rankingOrderSql,
    verifiedCensusSql,
    visibleCouponsWhere,
} from '@/lib/couponsDb'
import { describe, expect, it } from 'vitest'

// F-006 (plan step 3) — asserts each SQL fragment factory builds without
// throwing and its shape matches the pinned skeleton, using the REAL
// (unmocked) couponsSql — safe per F-011's couponsDb.test.ts precedent:
// porsager postgres.js only opens a socket on first query execution
// (`.then()`/`.execute()`), and vitest.config.ts's global env fixture
// already supplies a syntactically-valid (if unreachable)
// COUPONS_DATABASE_URL, so constructing the client and building — but
// never awaiting/executing — a query fragment does no I/O.
//
// Primary approach: postgres.js's own Query class exposes `.strings`
// (the template's literal chunks) and `.args` (the interpolated values,
// pre-serialization) as plain synchronous properties — the same fields its
// own fragment-composition code (stringify/fragment in postgres/src/types.js)
// reads to support nesting one sql`` fragment inside another, which this
// codebase already relies on (the marketing store page reuses one fragment
// across 2 queries). These properties aren't part of postgres.js's public
// .d.ts (PendingQuery<T> only types the awaited-result surface), so this
// file casts through `unknown` to reach them — the cast, not `any`, keeps
// everything else in the file honestly typed.
//
// Fallback for the one interpolation whose value isn't a plain literal
// (visibleCouponsWhere()'s status list, built via postgres.js's documented
// `sql(array)` "dynamic values" helper): assert it structurally consumed
// VISIBLE_COUPON_STATUSES via that helper's own `{first, rest}` shape,
// rather than re-deriving postgres.js's internal IN-list SQL text.

interface FragmentInternals {
    strings: readonly string[]
    args: readonly unknown[]
}

function internals(fragment: object): FragmentInternals {
    return fragment as unknown as FragmentInternals
}

describe('visibleCouponsWhere()', () => {
    it('builds without throwing', () => {
        expect(() => visibleCouponsWhere()).not.toThrow()
    })

    it('literal skeleton: "status IN <helper> AND expired = FALSE"', () => {
        const frag = internals(visibleCouponsWhere())
        expect(frag.strings.join('')).toBe('status IN  AND expired = FALSE')
        expect(frag.args).toHaveLength(1)
    })

    it('the one interpolation is postgres.js\'s sql(array) "dynamic values" helper, fed VISIBLE_COUPON_STATUSES', () => {
        const frag = internals(visibleCouponsWhere())
        const helper = frag.args[0] as { first: unknown; rest: unknown[] }
        expect(helper.first).toEqual([...VISIBLE_COUPON_STATUSES])
        expect(helper.rest).toEqual([])
    })

    it('is a factory — two calls return distinct fragment instances (no cross-request reuse)', () => {
        expect(visibleCouponsWhere()).not.toBe(visibleCouponsWhere())
    })
})

describe('rankingOrderSql()', () => {
    it('builds without throwing and is a pure literal (no interpolation)', () => {
        const frag = internals(rankingOrderSql())
        expect(frag.strings.join('')).toBe('rating DESC, created_at DESC')
        expect(frag.args).toHaveLength(0)
    })
})

describe('verifiedCensusSql()', () => {
    it("builds without throwing and is the bare status = 'valid' literal (no expired filter, no interpolation) — F-006's deliberate ruling: unchanged from pre-fix", () => {
        const frag = internals(verifiedCensusSql())
        expect(frag.strings.join('')).toBe("status = 'valid'")
        expect(frag.args).toHaveLength(0)
    })
})
