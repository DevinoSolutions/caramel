import {
    CouponListRowSchema,
    DiscountTypeRowSchema,
    SiteCountRowSchema,
    SiteRowSchema,
    SourceRowSchema,
    StatsRowSchema,
    StoreConfigRowSchema,
    TotalCountRowSchema,
    parseCouponRows,
} from '@/lib/couponsDb'
import { describe, expect, it } from 'vitest'

// F-001 — the runtime-validated read boundary over the externally-owned
// coupons DB. These tests exercise the 8 zod row schemas + parseCouponRows
// directly (no route/DB mocking needed — pure functions), proving each
// schema (a) accepts a production-shaped fixture, including the postgres.js
// runtime-type traps a naive schema would choke on (numeric columns
// arriving as strings, int4 ids as numbers vs int8 as strings), and
// (b) rejects drifted rows (missing column, renamed column, wrong type,
// null-where-required) instead of silently letting bad data through.

describe('CouponListRowSchema', () => {
    const validRow = {
        id: 42,
        code: 'SAVE10',
        site: 'example.com',
        title: 'Save 10% at Example',
        description: '10% off your order',
        rating: '4.5', // numeric column -> postgres.js returns a string
        discount_type: 'PERCENTAGE',
        discount_amount: '10', // numeric column -> string too
        expiry: '2026-12-31',
        expired: false,
        timesUsed: 5,
        status: 'valid',
        verificationMessage: null,
    }

    it('accepts a production-shaped row, coercing numeric-as-string columns and normalizing the id to a string', () => {
        const [row] = parseCouponRows(CouponListRowSchema, [validRow], 'test')
        expect(row).toEqual({
            ...validRow,
            id: '42',
            rating: 4.5,
            discount_amount: 10,
        })
    })

    it('also accepts an int8-shaped id (already a string) and a null discount_amount', () => {
        const [row] = parseCouponRows(
            CouponListRowSchema,
            [{ ...validRow, id: '9007199254740993', discount_amount: null }],
            'test',
        )
        expect(row.id).toBe('9007199254740993')
        expect(row.discount_amount).toBeNull()
    })

    it('rejects a row with a missing column (drift: renamed/dropped)', () => {
        const { code: _drop, ...drifted } = validRow
        expect(() =>
            parseCouponRows(CouponListRowSchema, [drifted], 'test'),
        ).toThrow(/coupons-db schema drift \[test\]/)
    })

    it('rejects a null id (never a legitimate value for a primary key) instead of coercing it to "null"', () => {
        expect(() =>
            parseCouponRows(
                CouponListRowSchema,
                [{ ...validRow, id: null }],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })

    // Real producer vocabulary (verified against the live oracle —
    // 23,167-row snapshot): 34 visible rows carry lowercase 'percentage',
    // 44 carry a 4th value ('fixed'), 8 carry null — 86 rows total the old
    // z.enum(['PERCENTAGE','CASH','SAVE']) rejected outright, 500ing the
    // main /api/coupons listing (its default `ORDER BY rating DESC` sorts
    // NULLS FIRST, so these rows sit at the top of page 1). coupon-card.tsx
    // only ever checks `=== 'PERCENTAGE'` — everything else renders
    // `$amount` — so normalizing casing is enough; no need to constrain
    // the vocabulary itself (matches DiscountTypeRowSchema's existing
    // philosophy for the same producer field, one describe block below).
    it('normalizes a lowercase discount_type to uppercase instead of rejecting it', () => {
        const [row] = parseCouponRows(
            CouponListRowSchema,
            [{ ...validRow, discount_type: 'percentage' }],
            'test',
        )
        expect(row.discount_type).toBe('PERCENTAGE')
    })

    it('accepts the 4th real producer value ("fixed"), uppercased — no longer a closed 3-value enum', () => {
        const [row] = parseCouponRows(
            CouponListRowSchema,
            [{ ...validRow, discount_type: 'fixed' }],
            'test',
        )
        expect(row.discount_type).toBe('FIXED')
    })

    it('accepts a null discount_type (genuinely unrated/pending coupons) and leaves it null', () => {
        const [row] = parseCouponRows(
            CouponListRowSchema,
            [{ ...validRow, discount_type: null }],
            'test',
        )
        expect(row.discount_type).toBeNull()
    })

    it('accepts a null expiry (same unrated/pending coupons have no expiry yet)', () => {
        const [row] = parseCouponRows(
            CouponListRowSchema,
            [{ ...validRow, expiry: null }],
            'test',
        )
        expect(row.expiry).toBeNull()
    })

    it('still rejects a genuinely non-string discount_type (e.g. a number) — structural drift, not producer vocabulary', () => {
        expect(() =>
            parseCouponRows(
                CouponListRowSchema,
                [{ ...validRow, discount_type: 42 }],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })

    it('rejects a wrong-type expired column (e.g. text instead of boolean)', () => {
        expect(() =>
            parseCouponRows(
                CouponListRowSchema,
                [{ ...validRow, expired: 'false' }],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('TotalCountRowSchema / StatsRowSchema — ::int-cast aggregates', () => {
    it('TotalCountRowSchema accepts a plain number (::int guarantees it)', () => {
        expect(
            parseCouponRows(TotalCountRowSchema, [{ total: 12 }], 'test'),
        ).toEqual([{ total: 12 }])
    })

    it('StatsRowSchema accepts total+expired', () => {
        expect(
            parseCouponRows(
                StatsRowSchema,
                [{ total: 10, expired: 3 }],
                'test',
            ),
        ).toEqual([{ total: 10, expired: 3 }])
    })

    it('rejects a numeric-as-string total (an ::int cast should never produce this — treat it as drift)', () => {
        expect(() =>
            parseCouponRows(TotalCountRowSchema, [{ total: '12' }], 'test'),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('SiteRowSchema / SiteCountRowSchema', () => {
    it('SiteRowSchema accepts a null site (consuming code already .filter(Boolean)s it)', () => {
        expect(
            parseCouponRows(SiteRowSchema, [{ site: null }], 'test'),
        ).toEqual([{ site: null }])
    })

    it('SiteCountRowSchema accepts the grouped {site,coupon_count} shape', () => {
        expect(
            parseCouponRows(
                SiteCountRowSchema,
                [{ site: 'example.com', coupon_count: 7 }],
                'test',
            ),
        ).toEqual([{ site: 'example.com', coupon_count: 7 }])
    })

    it('SiteCountRowSchema rejects a missing coupon_count (this is what the pre-fix top-sites generic silently omitted)', () => {
        expect(() =>
            parseCouponRows(
                SiteCountRowSchema,
                [{ site: 'example.com' }],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('DiscountTypeRowSchema — deliberately loose (not enum-constrained)', () => {
    it('accepts any string value, including one outside the 3 known CouponListRow discount types', () => {
        expect(
            parseCouponRows(
                DiscountTypeRowSchema,
                [{ discount_type: 'BOGO' }],
                'test',
            ),
        ).toEqual([{ discount_type: 'BOGO' }])
    })

    it('still rejects a missing discount_type column', () => {
        expect(() =>
            parseCouponRows(DiscountTypeRowSchema, [{}], 'test'),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('SourceRowSchema', () => {
    const validRow = {
        id: 'a1b2c3',
        source: 'example-source',
        websites: ['example.com', 'shop.example.com'],
        status: 'ACTIVE',
        total_coupons: 12,
        total_used: 4,
        total_expired: 1,
    }

    it('accepts a production-shaped row', () => {
        expect(parseCouponRows(SourceRowSchema, [validRow], 'test')).toEqual([
            validRow,
        ])
    })

    it('rejects websites as a non-array (drift: text instead of text[])', () => {
        expect(() =>
            parseCouponRows(
                SourceRowSchema,
                [{ ...validRow, websites: 'example.com' }],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('StoreConfigRowSchema — all 8 xpath fields nullable', () => {
    it('accepts a row with every xpath field present', () => {
        const row = {
            store_name: 'example.com',
            show_input_xpath: '//button[1]',
            dismiss_button_xpath: '//button[2]',
            coupon_input_xpath: '//input[1]',
            apply_button_xpath: '//button[3]',
            price_container_xpath: '//div[1]',
            success_indicator_xpath: '//div[2]',
            error_indicator_xpath: '//div[3]',
            coupon_remove_xpath: '//button[4]',
        }
        expect(parseCouponRows(StoreConfigRowSchema, [row], 'test')).toEqual([
            row,
        ])
    })

    it('accepts null for any of the 8 xpath fields', () => {
        const row = {
            store_name: 'example.com',
            show_input_xpath: null,
            dismiss_button_xpath: null,
            coupon_input_xpath: '//input[1]',
            apply_button_xpath: '//button[3]',
            price_container_xpath: null,
            success_indicator_xpath: '//div[2]',
            error_indicator_xpath: '//div[3]',
            coupon_remove_xpath: '//button[4]',
        }
        expect(parseCouponRows(StoreConfigRowSchema, [row], 'test')).toEqual([
            row,
        ])
    })

    it('rejects a missing store_name (the one required, non-xpath field)', () => {
        expect(() =>
            parseCouponRows(
                StoreConfigRowSchema,
                [
                    {
                        show_input_xpath: null,
                        dismiss_button_xpath: null,
                        coupon_input_xpath: null,
                        apply_button_xpath: null,
                        price_container_xpath: null,
                        success_indicator_xpath: null,
                        error_indicator_xpath: null,
                        coupon_remove_xpath: null,
                    },
                ],
                'test',
            ),
        ).toThrow(/coupons-db schema drift/)
    })
})

describe('parseCouponRows', () => {
    it('throws with the query label and issue path (array index + field)/message on drift', () => {
        // Parsing an ARRAY of rows means a bad field's path is prefixed with
        // its row index (e.g. "0.total"), not just the bare field name.
        expect(() =>
            parseCouponRows(TotalCountRowSchema, [{ total: 'x' }], 'my-query'),
        ).toThrow(/coupons-db schema drift \[my-query\]: 0\.total: /)
    })

    it('throws when the raw rows value is not an array at all (e.g. a driver/connection shape change)', () => {
        expect(() =>
            parseCouponRows(TotalCountRowSchema, undefined, 'my-query'),
        ).toThrow(/coupons-db schema drift \[my-query\]/)
    })

    it('returns an empty array unchanged (no coupons is a legitimate result, not drift)', () => {
        expect(parseCouponRows(TotalCountRowSchema, [], 'my-query')).toEqual([])
    })
})
