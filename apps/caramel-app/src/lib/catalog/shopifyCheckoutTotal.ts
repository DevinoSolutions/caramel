// T-9860: Shopify checkout configs whose total selector reads nothing.
//
// Shopify's one-page checkout hashes every class, so the total selectors the
// pipeline used to write ([data-checkout-payment-due-target],
// .payment-due__price, .total-recap__final-price...) match nothing on it
// (checked live 2026-10-28 on scosche.com, astleyclarke.com, sheds.co.uk).
// Applying a code still works there, but the extension cannot measure a saving
// or compare codes. caramel-coupons #256 rewrote the pipeline's rows to the
// stable hook below, yet the feed kept gaining rows without it: 59 on
// 2026-10-29, 129 of 1,489 Shopify checkout configs on 2026-11-06 (82 on the
// old family, 39 with no total at all).
//
// The feed puts the hook FIRST in such a row's priceContainer. The extension
// reads the first part of a selector list that is shown and holds an amount
// (dom-utils.js caramelPriceElement), so the one-page checkout reads the hook
// and an older checkout still reads the selectors the row already had. Only
// the served payload changes; the catalog row is left as the pipeline wrote it.
//
// TODO(T-9860): find what keeps writing Shopify checkout rows without the hook
// (pipeline lane); this stays as the backstop.

/** The one-page checkout's order total: only the Total row has a <strong> in
 * its row header (a VAT row after it does not, so :last-child would be wrong). */
export const SHOPIFY_CHECKOUT_TOTAL =
    '[aria-labelledby^="MoneyLine-Heading"] [role="row"]:has(> [role="rowheader"] strong) > [role="cell"] strong'

// The checkout's own discount box: input[name="reductions"] (any quoting).
const SHOPIFY_CHECKOUT_INPUT = /\[name=["']?reductions["']?\]/

// An XPath cannot share a comma list with a CSS selector.
const XPATH = /^\s*[/(]/

/**
 * The priceContainer to serve for a store config: the stored one, with the
 * Shopify one-page checkout total put first when the row's coupon input is
 * that checkout's box and its total does not already carry it.
 */
export function servedPriceContainer(
    couponInput: string | null | undefined,
    priceContainer: string | null | undefined,
): string | null {
    // Every other row is served exactly as stored.
    if (!couponInput || !SHOPIFY_CHECKOUT_INPUT.test(couponInput))
        return priceContainer ?? null
    const stored = priceContainer?.trim() || null
    if (!stored) return SHOPIFY_CHECKOUT_TOTAL
    if (stored.includes('MoneyLine-Heading') || XPATH.test(stored))
        return stored
    return `${SHOPIFY_CHECKOUT_TOTAL}, ${stored}`
}
