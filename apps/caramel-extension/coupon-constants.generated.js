// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: apps/caramel-app/src/lib/coupons.ts
// Regenerate: pnpm --filter caramel-app generate:coupon-constants
// (apps/caramel-app/scripts/generate-coupon-constants.ts)
//
// The coupon status vocabulary shared with the app (F-006), so the extension
// can never re-drift its own hard-coded copy of it. An ES module since the
// WXT P1 port (2026-08-12): consumers import { CaramelCoupons } and the
// module graph guarantees it is initialized before any reader evaluates (the
// successor to this file loading first in manifest/index.html order). The
// window publication survives in initCouponConstants() for the harnesses and
// any not-yet-ported call-time reader; the entrypoints call it first in realm
// order.
export const CaramelCoupons = {
    STATUSES: [
        'valid',
        'valid_with_warning',
        'product_restriction',
        'category_restricted',
        'seller_specific',
        'pending',
        'retry',
        'invalid',
        'expired',
    ],
    VISIBLE_STATUSES: [
        'valid',
        'valid_with_warning',
        'product_restriction',
        'category_restricted',
        'seller_specific',
        'pending',
        'retry',
    ],
    RESTRICTED_STATUSES: [
        'valid_with_warning',
        'product_restriction',
        'category_restricted',
        'seller_specific',
    ],
    STATUS_META: {
        valid: {
            label: '✓ Verified',
            tier: 'green',
        },
        valid_with_warning: {
            label: 'Verified · may vary',
            tier: 'amber',
        },
        product_restriction: {
            label: 'Restrictions apply',
            tier: 'amber',
        },
        category_restricted: {
            label: 'Category-limited',
            tier: 'amber',
        },
        seller_specific: {
            label: 'Seller-specific',
            tier: 'amber',
        },
        pending: {
            label: 'Unverified',
            tier: 'grey',
        },
        retry: {
            label: 'Unverified',
            tier: 'grey',
        },
        invalid: {
            label: 'Not valid',
            tier: 'red',
        },
        expired: {
            label: 'Expired',
            tier: 'red',
        },
    },
}

export function initCouponConstants() {
    window.CaramelCoupons = CaramelCoupons
}
