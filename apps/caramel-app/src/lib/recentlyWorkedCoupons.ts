// lib/recentlyWorkedCoupons.ts
//
// The ONE wire contract for GET /api/coupons/recently-worked — the landing
// page's "Codes that just worked" section. The route (producer) types its
// payload with RecentlyWorkedCouponsResponse and the landing section
// (consumer) parses the response with RecentlyWorkedCouponsResponseSchema, so
// a field rename fails type-check on the producer and parse on the consumer,
// never silently renders blanks.
//
// `zod/mini`, not classic `zod`: this module ships in the landing page's
// client bundle, and classic zod is kept out of browser code for the size
// reason recorded in src/lib/env.client.ts.
import * as z from 'zod/mini'

/** Most codes the section shows (and the read's LIMIT). Small on purpose: it is a below-the-fold proof strip, not a listing. */
export const RECENTLY_WORKED_COUPONS_LIMIT = 8

export const RecentlyWorkedCouponSchema = z.object({
    id: z.string(),
    code: z.string(),
    title: z.string(),
    /** Registrable domain (resolveStoreDomain) — the /coupons/<storeDomain> page the tile links to. */
    storeDomain: z.string(),
    /** Upper-cased by the catalog read boundary; open vocabulary (see CouponListRowSchema). */
    discountType: z.nullable(z.string()),
    discountAmount: z.nullable(z.number()),
    /** ISO timestamp of the shopper's successful apply (coupon_signals.last_worked_at). */
    lastWorkedAt: z.string(),
})
export type RecentlyWorkedCoupon = z.infer<typeof RecentlyWorkedCouponSchema>

export const RecentlyWorkedCouponsResponseSchema = z.object({
    coupons: z.array(RecentlyWorkedCouponSchema),
})
export type RecentlyWorkedCouponsResponse = z.infer<
    typeof RecentlyWorkedCouponsResponseSchema
>
