// F-006 — the status vocabulary's single source of truth moved to
// lib/coupons.ts (imported by both this 'use client'-safe type module and
// server-only couponsDb.ts). Re-exported here so existing importers
// (`import type { CouponStatus } from '@/types/coupon'`) keep resolving.
import type { CouponStatus } from '@/lib/coupons'

export type { CouponStatus }

export interface Coupon {
    id: string
    code: string
    site: string
    title: string
    description: string
    rating: number
    // Not a closed union — the read boundary (couponsDb.ts's
    // CouponListRowSchema) uppercase-normalizes whatever string the
    // Python producer emits (and allows null) rather than rejecting
    // anything outside PERCENTAGE/CASH/SAVE; see that schema's comment.
    // Consumers that care about the discount shape (coupon-card.tsx)
    // narrow with `=== 'PERCENTAGE'` and treat everything else uniformly.
    discount_type: string | null
    discount_amount: number | null
    // Nullable — genuinely unrated/pending coupons have no expiry yet.
    expiry: string | null
    expired: boolean
    timesUsed: number
    status?: CouponStatus
    verificationMessage?: string | null
    // App-owned trust signal (W1): ISO timestamp of the last extension-reported
    // "worked" outcome, attached in app code by couponSignals.ts's
    // attachSignals() from the coupon_signals table — NOT a column on the
    // external catalog. Absent/null until the extension starts reporting (W2);
    // the card/popup render "worked Xh ago" only when it's present and recent.
    lastWorkedAt?: string | null
    // Failure side of the same overlay (attachSignals): when the last failed
    // apply was reported and how many have been, in total. The card shows its
    // "Reported not working" hint from coupons.ts's isRecentlyFailing() over
    // these + lastWorkedAt — shopper/extension reports, not verification.
    lastFailedAt?: string | null
    failCount?: number
    // coupons.ts keepsFailing(), computed server-side by attachSignals so the
    // website and the extension popup collapse the same codes. false/absent when
    // there is no signal. Presentation only: never a status or a deletion.
    keepsFailing?: boolean
}

export interface CouponFilters {
    search: string
    site: string
    type: 'all' | 'PERCENTAGE' | 'CASH' | 'SAVE'
}
