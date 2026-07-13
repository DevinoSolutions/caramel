// lib/coupons.ts
//
// SINGLE source of truth for the coupon status vocabulary (F-006). Pure —
// no server imports — so it's importable by the 'use client' coupon-card.tsx
// component AND by the extension codegen script
// (scripts/generate-coupon-constants.ts), neither of which can pull in
// couponsSql (postgres-backed, server-only). couponsDb.ts's SQL fragments
// import VISIBLE_COUPON_STATUSES from here, not the other way around — no
// cycle.
//
// Before this module existed, "which statuses are visible" was hand-copied
// across 6 SQL call sites and had already drifted into 3 different
// definitions (coupons/route.ts's 7-status list, filters/route.ts's
// 'valid'-only list, stats/route.ts's 'valid'-only-without-expired-filter —
// see coupons-visibility.test.ts's pre-F-006 pins for the verbatim drift).
// The status->label/tier map was independently re-declared in the app
// (coupon-card.tsx's STATUS_BADGE) and the extension (popup.js's BADGE +
// shared-utils.js's RESTRICTED_STATUSES). STATUS_TABLE below is now the only
// place a coupon status is defined; every one of those sites derives from
// it instead.
const STATUS_TABLE = [
    {
        status: 'valid',
        label: '✓ Verified',
        tier: 'green',
        // Machine-verified by the Python verification service.
        visible: true,
        restricted: false,
    },
    {
        status: 'valid_with_warning',
        label: 'Verified · may vary',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'product_restriction',
        label: 'Restrictions apply',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'category_restricted',
        label: 'Category-limited',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'seller_specific',
        label: 'Seller-specific',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'pending',
        label: 'Unverified',
        tier: 'grey',
        // The bulk of the catalog: scraped, not yet run through
        // verification. Still shown with a neutral badge.
        visible: true,
        restricted: false,
    },
    {
        status: 'retry',
        label: 'Checking…',
        tier: 'grey',
        // Mid-verification (a prior attempt failed transiently).
        visible: true,
        restricted: false,
    },
    {
        status: 'invalid',
        label: 'Not valid',
        tier: 'red',
        // Known-dead — never surfaced in a listing.
        visible: false,
        restricted: false,
    },
    {
        status: 'expired',
        label: 'Expired',
        tier: 'red',
        visible: false,
        restricted: false,
    },
] as const

/** The 4 presentation tiers a status can render as. Tier->color (Tailwind classes app-side, hex popup-side) stays local to each platform — genuinely platform-specific and, being only 4 values, cannot drift on the 9-status axis the way the status vocabulary itself did. */
export type CouponStatusTier = (typeof STATUS_TABLE)[number]['tier']

export type CouponStatus = (typeof STATUS_TABLE)[number]['status']

/** All 9 statuses, table order. */
export const COUPON_STATUSES: readonly CouponStatus[] = STATUS_TABLE.map(
    s => s.status,
)

/**
 * The 7 statuses a listing should ever surface: verified, restriction-
 * tagged, AND not-yet-verified coupons. Excludes 'invalid'/'expired' so
 * known-dead codes are never shown. Drives every coupons-DB read query's
 * WHERE clause via couponsDb.ts's visibleCouponsWhere().
 */
export const VISIBLE_COUPON_STATUSES: readonly CouponStatus[] =
    STATUS_TABLE.filter(s => s.visible).map(s => s.status)

/**
 * The 4 statuses that carry a restriction the user might trip over (e.g.
 * "this code only applies to a specific category"). Drives the extension's
 * cart-classification trigger and restriction warning banner.
 */
export const RESTRICTED_COUPON_STATUSES: readonly CouponStatus[] =
    STATUS_TABLE.filter(s => s.restricted).map(s => s.status)

const VISIBLE_SET: ReadonlySet<string> = new Set(VISIBLE_COUPON_STATUSES)
const RESTRICTED_SET: ReadonlySet<string> = new Set(RESTRICTED_COUPON_STATUSES)

/** Type-guards an arbitrary (e.g. DB-sourced) status string against the visible set. */
export function isVisibleStatus(status: string): status is CouponStatus {
    return VISIBLE_SET.has(status)
}

/** Type-guards an arbitrary (e.g. DB-sourced) status string against the restricted set. */
export function isRestrictedStatus(status: string): status is CouponStatus {
    return RESTRICTED_SET.has(status)
}

/**
 * label + tier per status — the shared half of the app's coupon-card badge
 * and the extension's popup badge. Both platforms still keep their own
 * tier->color map (Tailwind vs. hex) locally; only the label/tier pairing
 * (the part that actually drifted) lives here.
 */
export const STATUS_META: Readonly<
    Record<CouponStatus, { label: string; tier: CouponStatusTier }>
> = STATUS_TABLE.reduce(
    (acc, s) => {
        acc[s.status] = { label: s.label, tier: s.tier }
        return acc
    },
    {} as Record<CouponStatus, { label: string; tier: CouponStatusTier }>,
)
