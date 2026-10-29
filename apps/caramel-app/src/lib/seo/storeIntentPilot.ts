// T-7856 store-page SEARCH-INTENT PILOT: four /coupons/<store> pages get a
// title, H1, description and above-the-fold note aimed at the query that
// already ranks them, because ranking is not the problem; clicks are.
//
// Search Console, 28 days to 2026-10-24 (all zero clicks):
//   coursera.org      "coursehero promo code" position 4.3, 22,590 impressions
//                     (Google reads Coursera as the answer; coursehero.com has
//                     3 codes and is not indexed), "coursera discount code" 711
//                     at 6.2, "coursera promo code" 478.
//   anthropologie.com "anthropologie coupon code" 4,417 at 5.3, "anthropologie
//                     promo code" 2,322 at 3.9.
//   dominos.com       "dominos coupons" 4,999 at 8.8.
//
// WHAT A PILOT ENTRY MAY CHANGE (storeMetadata.ts consumes titleHead and
// descriptor, page.tsx the h1 and the note):
//   titleHead     the term order that matches the query; the count / month /
//                 suffix fitting around it is unchanged.
//   descriptor    one phrase that says what the store is, in the description.
//   h1            an honest description of the page. Not "Best ... today":
//                 nothing on the page is verified today.
//   confusedWith  a store people mistake this one for; both pages link each
//                 other.
// Nothing here states a discount, a date or a count: those come from the same
// catalog facts the rest of the page prints (CLAIM INTEGRITY in
// storeMetadata.ts).
//
// MEASURE: 7 days after go-live, compare each page's CTR to the baseline above.
// Other store pages are untouched on purpose, so the read is clean.
//
// TODO(T-7856): after the read, generalize this to every store (derive the
// head and H1 from the query data) or delete the map. Until then it is a
// pilot: do not add stores to it without a new measurement plan.
export type StoreIntentPilotEntry = {
    titleHead?: string
    descriptor?: string
    h1?: string
    confusedWith?: { domain: string; name: string }
}

export const STORE_INTENT_PILOT: Readonly<
    Record<string, StoreIntentPilotEntry>
> = {
    // Keeps the default head ("Coursera Promo Codes & Coupons" already leads
    // with "Coursera Promo Codes").
    'coursera.org': {
        descriptor: 'the online-course platform',
        h1: 'Coursera promo codes & discount codes',
        confusedWith: { domain: 'coursehero.com', name: 'Course Hero' },
    },
    'coursehero.com': {
        h1: 'Course Hero promo codes & coupons',
        confusedWith: { domain: 'coursera.org', name: 'Coursera' },
    },
    'anthropologie.com': {
        titleHead: 'Anthropologie Promo Codes & Coupon Codes',
        h1: 'Anthropologie promo codes & coupon codes',
    },
    'dominos.com': {
        titleHead: "Domino's Coupons & Promo Codes",
        h1: "Domino's coupons & promo codes",
    },
}

/** The pilot entry for a registrable store domain, or null for every other
 *  store (whose output must not change). */
export function storeIntentPilotFor(
    base: string,
): StoreIntentPilotEntry | null {
    return Object.prototype.hasOwnProperty.call(STORE_INTENT_PILOT, base)
        ? STORE_INTENT_PILOT[base]
        : null
}

/** "worked in the last N days" window of the freshness note. */
export const WORKED_WINDOW_DAYS = 7

export type StoreFreshnessLine = {
    /** "20 codes" / "1 code" */
    codes: string
    /** The list's last update; null when the catalog has no date for it. */
    updated: { label: string; dateTime: string } | null
    /** "3 worked in the last 7 days"; null when none did. */
    worked: string | null
}

function utcDayNumber(date: Date): number {
    return Math.floor(date.getTime() / 86_400_000)
}

/** "today" / "yesterday" by UTC day, else "Aug 4, 2026". */
function updatedLabel(lastUpdated: Date, now: Date): string {
    const daysAgo = utcDayNumber(now) - utcDayNumber(lastUpdated)
    if (daysAgo === 0) return 'today'
    if (daysAgo === 1) return 'yesterday'
    return lastUpdated.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    })
}

/**
 * The note under a pilot page's H1: "<N> codes · list updated <when> · <k>
 * worked in the last 7 days".
 *
 * CLAIM INTEGRITY. N is the listed count; "list updated" is the newest
 * updated_at among the store's codes (the date the FAQ prints); k counts codes
 * a shopper's checkout applied successfully inside the window
 * (coupon_signals.last_worked_at). It NEVER says "verified": no per-code
 * verification timestamp exists, so "verified today" would be a false claim.
 */
export function buildStoreFreshnessLine(input: {
    total: number
    lastUpdated: Date | null
    workedInWindow: number
    now: Date
}): StoreFreshnessLine {
    const { total, lastUpdated, workedInWindow, now } = input
    return {
        codes: `${total.toLocaleString('en-US')} ${total === 1 ? 'code' : 'codes'}`,
        updated: lastUpdated
            ? {
                  label: updatedLabel(lastUpdated, now),
                  dateTime: lastUpdated.toISOString(),
              }
            : null,
        worked:
            workedInWindow > 0
                ? `${workedInWindow.toLocaleString('en-US')} worked in the last ${WORKED_WINDOW_DAYS} days`
                : null,
    }
}
