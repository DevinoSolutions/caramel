import { GET } from '@/app/api/extension/supported-stores/route'
import { resetSupportedStoresCache } from '@/lib/supportedStoresCache'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-003 — GET /api/extension/supported-stores is a public read: the payload
// is xpath selectors already shipped to every extension install, so gating it
// behind a key has no secrecy value. Rate-limited like any other public read
// route. A stale x-api-key header from a pre-F-003 extension build is simply
// ignored — no cutover required (see PLAN-F-003.md §Breaking).
//
// W4 — listSupportedStoreConfigs now reads the app's FLATTENED store_configs
// table via `prisma.$queryRaw(Prisma.sql`...`)`, so `@/lib/prisma` is mocked:
// `$queryRaw` records the composed `.sql` so a test can assert the WHERE
// predicate (which xpath columns the query requires); the row mock always
// resolves to [], so it can't otherwise prove anything about the predicate.
const { queryCapture } = vi.hoisted(() => ({
    queryCapture: { sql: '' },
}))

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            queryCapture.sql = arg.sql
            return Promise.resolve([])
        },
    },
}))

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
    // The route serves a 5-min in-process cache of the serialized body; drop
    // it so every test below reaches the (mocked) query.
    resetSupportedStoresCache()
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

// D1 (E2E report) — the extension's apply engine (coupon-apply.js) can only
// work when it has BOTH the coupon input and the apply button: applyCoupon()
// and coupon-runner.js's startApplyingCoupons() bail early
// (`if (!input || ... || !applyBtn) return`) when either is missing. The other
// xpaths all have generic fallbacks (findAppliedSelector/detectCouponError/
// findRemoveSelector → GENERIC_* constants), so requiring them would exclude
// ~25% of active configs — incl. the 3 demo stores — for no reason.
//
// W4 remap (RULING B): the app's store_configs is the FLATTENED published
// shape — no pipeline-internal is_active/priority/store_id/metadata columns
// (the highest-priority-active + extension_compatible selection is
// pre-resolved at ingest time). So the query is a plain projection off
// store_configs; the ONLY WHERE predicate left is the input+button non-null
// business filter.
describe('GET /api/extension/supported-stores — qualification predicate (D1 fix, W4 flattened table)', () => {
    it('reads store_configs, requiring coupon_input_xpath + apply_button_xpath — NOT success/error/remove indicators, and NOT the retired extension_compatible metadata filter', async () => {
        queryCapture.sql = ''

        await GET(makeRequest())

        expect(queryCapture.sql).toMatch(/FROM store_configs/)
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
        // The flattened table has no metadata column — extension_compatible is
        // resolved at ingest, so it must NOT appear as a query predicate.
        expect(queryCapture.sql).not.toMatch(/extension_compatible/)
    })
})
