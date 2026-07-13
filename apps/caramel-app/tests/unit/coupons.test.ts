import {
    COUPON_STATUSES,
    RESTRICTED_COUPON_STATUSES,
    STATUS_META,
    VISIBLE_COUPON_STATUSES,
    isRestrictedStatus,
    isVisibleStatus,
} from '@/lib/coupons'
import { describe, expect, it } from 'vitest'

// F-006 — characterization pins for the coupon-domain module, written
// BEFORE any call site is rewired to consume it (plan step 1: "asserts
// today's vocabulary before any move"). These pin the exact vocabulary
// coupons-visibility.test.ts's pre-fix predicates and coupon-card.tsx's
// STATUS_BADGE / the extension's popup BADGE + shared-utils.js's
// RESTRICTED_STATUSES already encoded — verbatim, so this is a real
// characterization of pre-existing behavior, not a fresh design pinned
// after the fact.

describe('COUPON_STATUSES — all 9, table order', () => {
    it('matches the CouponStatus union pre-F-006 (types/coupon.ts)', () => {
        expect(COUPON_STATUSES).toEqual([
            'valid',
            'valid_with_warning',
            'product_restriction',
            'category_restricted',
            'seller_specific',
            'pending',
            'retry',
            'invalid',
            'expired',
        ])
    })
})

describe('VISIBLE_COUPON_STATUSES — exact 7, order matches every pre-fix SQL literal', () => {
    it('matches the verbatim IN (...) list from coupons/route.ts, sites/top-sites, sites/search-supported, coupons/stores (x2), and the marketing store page', () => {
        expect(VISIBLE_COUPON_STATUSES).toEqual([
            'valid',
            'valid_with_warning',
            'product_restriction',
            'category_restricted',
            'seller_specific',
            'pending',
            'retry',
        ])
    })

    it('excludes invalid and expired', () => {
        expect(VISIBLE_COUPON_STATUSES).not.toContain('invalid')
        expect(VISIBLE_COUPON_STATUSES).not.toContain('expired')
    })
})

describe('RESTRICTED_COUPON_STATUSES — exact 4, matches the extension pre-fix (shared-utils.js RESTRICTED_STATUSES / popup.js restrictedSet)', () => {
    it('contains exactly the 4 statuses both extension sites hard-coded', () => {
        expect(new Set(RESTRICTED_COUPON_STATUSES)).toEqual(
            new Set([
                'product_restriction',
                'category_restricted',
                'seller_specific',
                'valid_with_warning',
            ]),
        )
        expect(RESTRICTED_COUPON_STATUSES).toHaveLength(4)
    })
})

describe('isVisibleStatus / isRestrictedStatus — predicate truth-table (all 9 statuses)', () => {
    const table: Array<{
        status: string
        visible: boolean
        restricted: boolean
    }> = [
        { status: 'valid', visible: true, restricted: false },
        { status: 'valid_with_warning', visible: true, restricted: true },
        { status: 'product_restriction', visible: true, restricted: true },
        { status: 'category_restricted', visible: true, restricted: true },
        { status: 'seller_specific', visible: true, restricted: true },
        { status: 'pending', visible: true, restricted: false },
        { status: 'retry', visible: true, restricted: false },
        { status: 'invalid', visible: false, restricted: false },
        { status: 'expired', visible: false, restricted: false },
    ]

    it.each(table)(
        '$status -> visible=$visible, restricted=$restricted',
        ({ status, visible, restricted }) => {
            expect(isVisibleStatus(status)).toBe(visible)
            expect(isRestrictedStatus(status)).toBe(restricted)
        },
    )

    it('an unknown status is neither visible nor restricted', () => {
        expect(isVisibleStatus('some_future_status')).toBe(false)
        expect(isRestrictedStatus('some_future_status')).toBe(false)
    })
})

describe('STATUS_META — label + tier, verbatim from coupon-card.tsx STATUS_BADGE / popup.js BADGE (identical across app+extension pre-fix)', () => {
    it('pins every label and tier', () => {
        expect(STATUS_META).toEqual({
            valid: { label: '✓ Verified', tier: 'green' },
            valid_with_warning: {
                label: 'Verified · may vary',
                tier: 'amber',
            },
            product_restriction: {
                label: 'Restrictions apply',
                tier: 'amber',
            },
            category_restricted: { label: 'Category-limited', tier: 'amber' },
            seller_specific: { label: 'Seller-specific', tier: 'amber' },
            pending: { label: 'Unverified', tier: 'grey' },
            retry: { label: 'Checking…', tier: 'grey' },
            invalid: { label: 'Not valid', tier: 'red' },
            expired: { label: 'Expired', tier: 'red' },
        })
    })

    it('every restricted status is tier amber (the 3-color axis the app/extension local maps still branch on)', () => {
        for (const status of RESTRICTED_COUPON_STATUSES) {
            expect(STATUS_META[status].tier).toBe('amber')
        }
    })
})
