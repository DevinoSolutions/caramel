// The /coupons/<store> page's <title>, meta description and display name.
//
// WHY THIS EXISTS. Search Console, 28 days to 2026-10-13: /coupons/coursera.org
// took 27.4k impressions at an average position of 4.6 and earned no clicks.
// /coupons/anthropologie.com (6.8k, position 4.8), groupon.com (6.3k, 3.2) and
// tradeinn.com (5.8k, 3.5) did the same: top-5 positions, zero clicks. The
// queries are "<brand> promo code" / "coupon code" / "discount code"
// ("coursera discount code" 711, "coursera promo code" 478, "coursera coupon"
// 439), and the old title answered them with a lowercase domain and a
// sentence: "coursera.org coupons & promo codes — 22 active codes | Caramel".
// The result next to it reads "Coursera Promo Code: ...". The snippet now
// leads with the brand, names the three words people search, and states what
// the page actually holds.
//
// CLAIM INTEGRITY (same rule as storeFaq.ts): every number comes from the
// catalog read the page already makes. The display name is the store's own
// domain label, title-cased (coursera.org -> "Coursera"), or a brand spelling
// from the short list below; nothing else about the store is said. The month
// is the month the store's list was last updated (its newest updated_at, the
// date the FAQ prints), and it appears only while that month is the current
// one: a title never dates a list to a month it was not updated in.
import type { StoreCouponFacts } from '@/lib/couponsRepo'
import { parse } from 'tldts'

// Google cuts titles at about 600px (roughly 60 characters) and descriptions
// at about 155-160 characters. The builders pick the longest candidate that
// fits, so nothing is cut mid-word in the result.
const TITLE_MAX = 60
const DESCRIPTION_MAX = 155
const SITE_SUFFIX = ' | Caramel'

// Brand spellings a title-cased domain label gets wrong, for stores with
// Search Console impressions (or a home-page card). Keyed by the label in
// front of the public suffix, so eharmony.ca and eharmony.com share one entry.
const BRAND_SPELLINGS: Readonly<Record<string, string>> = {
    bestbuy: 'Best Buy',
    coursehero: 'Course Hero',
    dhccare: 'DHC Care',
    dominos: "Domino's",
    ebay: 'eBay',
    eharmony: 'eHarmony',
    getthelabel: 'Get The Label',
    humehealth: 'Hume Health',
    mountainwarehouse: 'Mountain Warehouse',
    mypillow: 'MyPillow',
    parksleepfly: 'ParkSleepFly',
    prettylittlething: 'PrettyLittleThing',
    simplybe: 'Simply Be',
    westmarine: 'West Marine',
}

/** The name a shopper searches a store by: "Coursera" for coursera.org,
 *  "Philips Hue" for philips-hue.com. Falls back to the domain itself when it
 *  has no label in front of its public suffix. */
export function storeDisplayName(base: string): string {
    const label = parse(base).domainWithoutSuffix
    if (!label) return base
    const known = BRAND_SPELLINGS[label]
    if (known) return known
    return label
        .split('-')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

export type StoreMetadataInput = {
    /** Registrable store domain (resolveStoreDomain). */
    base: string
    /** Active (visible) codes: the count the page lists. */
    total: number
    facts: StoreCouponFacts
    /** UK store: "discount code" / "voucher" vocabulary. */
    uk: boolean
    /** Render time. A parameter so tests can pin it. */
    now: Date
}

function fitting(candidates: string[], max: number): string {
    return (
        candidates.find(candidate => candidate.length <= max) ??
        candidates[candidates.length - 1]
    )
}

function sameUtcMonth(a: Date, b: Date): boolean {
    return (
        a.getUTCFullYear() === b.getUTCFullYear() &&
        a.getUTCMonth() === b.getUTCMonth()
    )
}

/** "October 2026" and "Oct 2026" for a list updated this month, else null. */
function updatedThisMonth(
    lastUpdated: Date | null,
    now: Date,
): { long: string; short: string } | null {
    if (!lastUpdated || !sameUtcMonth(lastUpdated, now)) return null
    const format = (month: 'long' | 'short') =>
        lastUpdated.toLocaleDateString('en-US', {
            month,
            year: 'numeric',
            timeZone: 'UTC',
        })
    return { long: format('long'), short: format('short') }
}

export function buildStoreTitle(input: StoreMetadataInput): string {
    const { base, total, facts, uk, now } = input
    const name = storeDisplayName(base)
    if (total <= 0) {
        // Noindexed empty state: no count, no date.
        return uk
            ? `${name} Discount Codes & Voucher Codes${SITE_SUFFIX}`
            : `${name} Coupons & Promo Codes${SITE_SUFFIX}`
    }
    const head = uk
        ? `${name} Discount Codes & Vouchers`
        : `${name} Promo Codes & Coupons`
    const count = total.toLocaleString('en-US')
    const codes = total === 1 ? 'Code' : 'Codes'
    const month = updatedThisMonth(facts.lastUpdated, now)
    const dated = month
        ? [
              `${head}: ${count} ${codes}, ${month.long}${SITE_SUFFIX}`,
              `${head}: ${count} ${codes}, ${month.short}${SITE_SUFFIX}`,
              `${head}: ${count} ${codes}, ${month.long}`,
              `${head}: ${count} ${codes}, ${month.short}`,
          ]
        : []
    return fitting(
        [
            ...dated,
            `${head}: ${count} Active ${codes}${SITE_SUFFIX}`,
            `${head}: ${count} ${codes}${SITE_SUFFIX}`,
            `${head}: ${count} ${codes}`,
            `${head}${SITE_SUFFIX}`,
            head,
        ],
        TITLE_MAX,
    )
}

export function buildStoreDescription(input: StoreMetadataInput): string {
    const { base, total, facts, uk } = input
    const name = storeDisplayName(base)
    if (total <= 0) {
        return uk
            ? `Find ${name} discount codes, voucher codes and promo codes for ${base}, refreshed as new codes are found.`
            : `Find ${name} coupon codes, promo codes and discounts for ${base}, refreshed as new codes are found.`
    }
    const count = total.toLocaleString('en-US')
    const one = total === 1
    // The biggest percent-off amount among the listed codes: the same number
    // the FAQ states ("up to N% off").
    const upTo =
        facts.bestPercentOff !== null
            ? `, up to ${Number(facts.bestPercentOff.toFixed(1))}% off`
            : ''
    const full = uk
        ? one
            ? 'discount code'
            : 'discount codes, voucher codes & promo codes'
        : one
          ? 'promo code'
          : 'promo codes, coupons & discount codes'
    const short = uk
        ? one
            ? 'discount code'
            : 'discount codes & vouchers'
        : one
          ? 'promo code'
          : 'promo codes & coupons'
    const action = one
        ? "Copy it, or let Caramel's free extension try it at checkout."
        : "Copy a code, or let Caramel's free extension try them at checkout."
    return fitting(
        [
            `${count} ${name} ${full} for ${base}${upTo}. ${action}`,
            `${count} ${name} ${full}${upTo}. ${action}`,
            `${count} ${name} ${short}${upTo}. ${action}`,
            `${count} ${name} ${short}${upTo}.`,
        ],
        DESCRIPTION_MAX,
    )
}
