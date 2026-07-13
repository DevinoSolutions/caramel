import {
    couponsQueryProbes,
    expireCoupons,
    getCouponStats,
    incrementCouponUsage,
    listCoupons,
    requestSource,
} from '@/lib/couponsRepo'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Replaces the deleted tests/unit/check-coupons-schema.test.ts (the old
// EXPECTED_COLUMNS-mirror unit test — see PLAN-COUPONS-BOUNDARY.md). Two
// jobs: (1) pin the couponsQueryProbes registry SHAPE the structural drift
// gate (tests/drift/coupons-schema.drift.ts) depends on, and (2) a couple
// of direct fn-level pins so couponsRepo.ts itself has coverage that
// doesn't route through an HTTP handler. Exhaustive query-shape/behavior
// pinning per route already lives in coupons-read-boundary.test.ts,
// coupons-visibility.test.ts, coupons-store-page.test.ts,
// supported-stores.test.ts, and coupons-expire.test.ts — this file is
// deliberately NOT a duplicate of those.
//
// Same mock shape as coupons-read-boundary.test.ts: couponsSql is a
// recording, rule-based thenable so one mock factory serves every query
// this file exercises. importActual keeps parseCouponRows + the real
// schemas/fragment factories wired (couponsRepo imports them too).
type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/couponsDb', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/couponsDb')>(
            '@/lib/couponsDb',
        )
    return {
        ...actual,
        couponsSql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
            const sql = strings.join('?')
            const rows = rules.find(r => r.match(sql))?.rows ?? []
            return {
                // oxlint-disable-next-line no-thenable
                then: (resolve: (rows: unknown[]) => void) => resolve(rows),
            }
        },
    }
})

beforeEach(() => {
    rules = []
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

describe('couponsQueryProbes registry (drift-gate contract)', () => {
    it('has exactly 13 probes, one per read/write query, in the plan-fixed order', () => {
        const labels = couponsQueryProbes.map(p => p.label)
        expect(labels).toEqual([
            'coupons.list',
            'store-page.coupons',
            'coupons.stats',
            'coupons.stores',
            'coupons.filters.sites',
            'coupons.filters.types',
            'sites.top-sites',
            'sites.search-supported',
            'extension.supported-stores',
            'sources.list',
            'coupons.increment',
            'coupons.expire',
            'sources.insert',
        ])
    })

    it("every label is unique — the gate's red output names a label unambiguously", () => {
        const labels = couponsQueryProbes.map(p => p.label)
        expect(new Set(labels).size).toBe(labels.length)
    })

    it('flags exactly the 3 sanctioned writes as write:true — every other probe is a plain read', () => {
        const writeLabels = couponsQueryProbes
            .filter(p => p.write)
            .map(p => p.label)
        expect(writeLabels).toEqual([
            'coupons.increment',
            'coupons.expire',
            'sources.insert',
        ])
    })

    it('every probe exposes a callable run(sql) fn', () => {
        for (const probe of couponsQueryProbes) {
            expect(typeof probe.run).toBe('function')
        }
    })
})

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

describe('expireCoupons (write)', () => {
    it('returns rows.length from the UPDATE...RETURNING id', async () => {
        mockRows(
            sql =>
                sql.includes('UPDATE coupons') &&
                sql.includes('expired = TRUE'),
            [{ id: 1 }, { id: 2 }],
        )

        await expect(expireCoupons([1, 2])).resolves.toBe(2)
    })

    it('returns 0 when no row matched', async () => {
        mockRows(
            sql =>
                sql.includes('UPDATE coupons') &&
                sql.includes('expired = TRUE'),
            [],
        )

        await expect(expireCoupons([999999])).resolves.toBe(0)
    })
})

describe('incrementCouponUsage (write)', () => {
    it('returns rows[0] (untyped passthrough, no zod) when a row matched', async () => {
        const row = {
            id: '42',
            code: 'SAVE10',
            site: 'example.com',
            timesUsed: 6,
        }
        mockRows(sql => sql.includes('times_used = times_used + 1'), [row])

        await expect(incrementCouponUsage(42)).resolves.toEqual(row)
    })

    it('returns undefined when no coupon matched the id', async () => {
        mockRows(sql => sql.includes('times_used = times_used + 1'), [])

        await expect(incrementCouponUsage(999999)).resolves.toBeUndefined()
    })
})

describe('requestSource (write)', () => {
    it('issues the sources INSERT and resolves void', async () => {
        mockRows(sql => sql.includes('INSERT INTO sources'), [])

        await expect(requestSource('example.com')).resolves.toBeUndefined()
    })
})
