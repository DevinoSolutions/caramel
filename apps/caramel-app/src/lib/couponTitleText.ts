// lib/couponTitleText.ts
//
// What a shopper may read as a coupon's title.
//
// The `title` column comes from the catalog supplier's scrapers, and on some
// stores it is not a title at all. Live catalog, 2026-09-30, the 60 store
// pages with the most Search Console impressions (1,455 visible rows):
//   * a bare button label: "CODE" (131 rows), "SALE" — every one of
//     eharmony.ca's 12 codes, all 20 of abercrombie.ca's;
//   * another coupon site's page chrome: "30% off • 29 Competitor Deals •
//     Last Checked: Just now Top codes Best deals Activity Saving hacks FAQ
//     Today's Groupon promo code" (groupon, coursera, chewy, adorama,
//     ticketmaster, dhgate, gopuff, lyft, dominos), and "15% off Code Code
//     Verified Storewide Show Code … Last used: Recently Uses today: 0".
// Each store page prints the title as the coupon's heading, in its ItemList
// JSON-LD and in its FAQ answer ('The one Caramel ranks first is "CODE"'), so
// those pages told Google, and shoppers, nothing about the code. Every read
// that serves coupons (couponsRepo) passes the title through
// shopperCouponTitle, the same way it passes verification_message through
// shopperVerificationText, so /api/coupons (the extension popup, agents), the
// SSR store pages and the landing's "Codes that just worked" all agree.
//
// A replacement title is built only from the row's own columns (amount, type,
// store, code), never invented copy. The catalog row itself is not rewritten:
// the supplier owns it (DESIGN.md §2 "Write-ownership").

import { discountBadgeText } from '@/lib/coupons'

/** A title that is only a button or badge label, not a description. */
const PLACEHOLDER_TITLE =
    /^(code|codes|coupon|coupons|coupon code|promo|promo code|discount|discount code|voucher|voucher code|deal|deals|sale|offer|offers|get code|show code|get deal)$/i

/** Another coupon site's page chrome captured with the title. */
const SCRAPED_CHROME_MARKERS: readonly RegExp[] = [
    /competitor deals/i,
    /last checked:/i,
    /\bshow code\b/i,
    /\buses today:/i,
    /\blast used:/i,
    /\bsaving hacks\b/i,
]

type CouponTitleSource = {
    title: string
    code: string
    site: string
    discount_type: string | null
    discount_amount: number | null
}

/** True when the catalog title says nothing a shopper can use. */
export function isUnusableCouponTitle(title: string): boolean {
    const text = title.replace(/\s+/g, ' ').trim()
    if (text === '') return true
    if (PLACEHOLDER_TITLE.test(text)) return true
    return SCRAPED_CHROME_MARKERS.some(marker => marker.test(text))
}

/**
 * The title a shopper sees for a coupon: the catalog title when it is one,
 * otherwise one built from the row's percent off ("20% off at chewy.com") or,
 * failing that, its code ("eharmony.ca promo code EHLOVE20").
 *
 * Only a percentage is stated. A fixed amount has no currency in the catalog
 * (storeFaq.ts states none for the same reason), and this title is repeated
 * in JSON-LD and the FAQ answer, so "$10 off at boots.co.uk" would be a
 * claim the row cannot back. Percent-off amounts of 100 or more are producer
 * errors (couponsRepo.ts percentOffSql); both fall back to the code.
 */
export function shopperCouponTitle(row: CouponTitleSource): string {
    if (!isUnusableCouponTitle(row.title)) {
        return row.title.replace(/\s+/g, ' ').trim()
    }
    const site = row.site.trim()
    const amount = row.discount_amount
    const usablePercent =
        row.discount_type === 'PERCENTAGE' &&
        amount !== null &&
        amount > 0 &&
        amount < 100
    const badge = usablePercent
        ? discountBadgeText(row.discount_type, amount)
        : null
    if (badge) return `${badge} off at ${site}`
    const code = row.code.trim()
    return code ? `${site} promo code ${code}` : `${site} promo code`
}
