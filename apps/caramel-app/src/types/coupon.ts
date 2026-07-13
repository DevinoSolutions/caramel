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
}

export interface CouponFilters {
    search: string
    site: string
    type: 'all' | 'PERCENTAGE' | 'CASH' | 'SAVE'
}
