import { GET } from '@/app/api/extension/supported-stores/route'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-003 — GET /api/extension/supported-stores becomes a public read: the
// payload is xpath selectors already shipped to every extension install, so
// gating it behind a key has no secrecy value. Rate-limited like any other
// public read route. A stale x-api-key header from a pre-F-003 extension
// build is simply ignored — no cutover required (see PLAN-F-003.md §Breaking).

// F-001 — re-export the REAL schemas/parseCouponRows via importActual and
// only replace couponsSql itself: the route now imports parseCouponRows +
// StoreConfigRowSchema from this module too, and a factory that provided
// just `{ couponsSql }` would leave those undefined (TypeError before the
// SQL mock is ever reached). An empty-array result parses through the real
// schema trivially, so this stays a true characterization of unchanged
// behavior.
// Captures the literal SQL text of the most recent couponsSql call so a
// test can assert on the QUERY SHAPE (which xpath columns the WHERE
// actually requires) — the row-mock below always resolves to [], so it
// can't otherwise prove anything about the predicate itself.
const { queryCapture } = vi.hoisted(() => ({
    queryCapture: { sql: '' },
}))

vi.mock('@/lib/couponsDb', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/couponsDb')>(
            '@/lib/couponsDb',
        )
    return {
        ...actual,
        couponsSql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
            queryCapture.sql = strings.join('?')
            return {
                // oxlint-disable-next-line no-thenable
                then: (resolve: (rows: unknown[]) => void) => resolve([]),
            }
        },
    }
})

const { checkRateLimitMock } = vi.hoisted(() => ({
    checkRateLimitMock: vi.fn(async () => null as NextResponse | null),
}))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: checkRateLimitMock }))

function makeRequest(headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/extension/supported-stores', {
        headers,
    })
}

beforeEach(() => {
    checkRateLimitMock.mockClear()
    checkRateLimitMock.mockImplementation(async () => null)
})

describe('GET /api/extension/supported-stores — public read (F-003)', () => {
    it('no key header → 200', async () => {
        const res = await GET(makeRequest())
        expect(res.status).toBe(200)
    })

    it('a stale x-api-key header from a pre-F-003 extension build is ignored → 200', async () => {
        const res = await GET(
            makeRequest({
                'x-api-key': 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA',
            }),
        )
        expect(res.status).toBe(200)
    })

    it('rate limiting is delegated to checkRateLimit — a 429 from it passes through untouched', async () => {
        const limited = NextResponse.json(
            { error: 'Too many requests. Please slow down.' },
            { status: 429 },
        )
        checkRateLimitMock.mockImplementation(async () => limited)

        const res = await GET(makeRequest())

        expect(res.status).toBe(429)
        expect(checkRateLimitMock).toHaveBeenCalledWith(
            expect.anything(),
            'read',
        )
    })
})

// D1 (E2E report) — the old predicate required ALL of coupon_input,
// apply_button, success_indicator, error_indicator AND coupon_remove to be
// non-null, excluding ~25% of active configs (incl. the 3 hardcoded demo
// stores: ebay.com/amazon.com/codecademy.com) even though the extension's
// apply engine has generic fallbacks for everything except the input+button
// pair:
//   - successIndicator: coupon-apply.js findAppliedSelector() falls back to
//     GENERIC_APPLIED_SELECTORS
//   - errorIndicator: coupon-apply.js detectCouponError() falls back to a
//     GENERIC_ERROR_TEXT_RE scan near the input
//   - couponRemove: coupon-apply.js findRemoveSelector() falls back to
//     GENERIC_REMOVE_SELECTORS, and removeAppliedCoupon() has a further
//     clear-the-input fallback
// couponInput/couponSubmit have NO such fallback — coupon-apply.js's
// applyCoupon() and coupon-runner.js's startApplyingCoupons() both bail
// early (`if (!input || ... || !applyBtn) return`) when either is missing,
// so those two remain hard requirements.
describe('GET /api/extension/supported-stores — qualification predicate (D1 fix)', () => {
    it('requires coupon_input_xpath + apply_button_xpath — NOT success/error/remove indicators', async () => {
        queryCapture.sql = ''

        await GET(makeRequest())

        expect(queryCapture.sql).toMatch(/coupon_input_xpath\s+IS NOT NULL/)
        expect(queryCapture.sql).toMatch(/apply_button_xpath\s+IS NOT NULL/)
        expect(queryCapture.sql).not.toMatch(
            /success_indicator_xpath\s+IS NOT NULL/,
        )
        expect(queryCapture.sql).not.toMatch(
            /error_indicator_xpath\s+IS NOT NULL/,
        )
        expect(queryCapture.sql).not.toMatch(
            /coupon_remove_xpath\s+IS NOT NULL/,
        )
        // The extension_compatible escape hatch (agent/manual "this store
        // genuinely doesn't work" verdict) is unrelated to xpath
        // nullability and must survive the relaxation unchanged.
        expect(queryCapture.sql).toMatch(/extension_compatible/)
    })
})
