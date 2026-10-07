/**
 * The store listing as code (2026-10-05, Chrome Web Store pass) — the ONE
 * source for the extension's public name, summary and detailed description:
 *
 *   - wxt.config.ts stamps NAME / FIREFOX_NAME and SUMMARY into the generated
 *     manifests (the Chrome Web Store, AMO and Edge all read the listing title
 *     and short description FROM the manifest, read-only on their dashboards),
 *   - DESCRIPTION is pasted into each store's "Detailed description" field by
 *     hand at submission time (no store reads it from the package),
 *   - tests/store-listing.test.mjs pins the store length limits and the claims
 *     the extension does not back up.
 *
 * Every sentence here must be something the shipped extension actually does
 * (claim audit 2026-10-05): codes are applied after ONE tap on the checkout
 * prompt (not silently), at most 8 codes per attempt, savings are read from
 * the store's own cart total, there is no affiliate code, no cashback, no
 * price history, and the only server is grabcaramel.com. Don't mention the
 * cart classifier as "AI", and don't mention shopper code capture while its
 * server flag is off.
 */

/** Chrome Web Store title (max 75). Also what the Chrome zip carries to Edge. */
export const NAME =
    'Caramel: Automatic Coupon Finder & Promo Codes, Honey Alternative'

/**
 * AMO caps the name at 50 characters (and Edge at 45), so the Firefox build
 * carries a shorter name with the same brand + main keywords.
 * TODO: Edge Add-ons reuses the CHROME zip (release-extension.yml
 * publish_edge, dormant until the EDGE_* secrets exist) and Edge rejects
 * names over 45 characters — before activating publish_edge, give Edge its
 * own build whose manifest carries FIREFOX_NAME (it fits 45).
 */
export const FIREFOX_NAME = 'Caramel: Coupon Finder & Honey Alternative'

/** Manifest `description` = the store short description (CWS max 132). */
export const SUMMARY =
    "Auto-apply coupon codes at checkout and keep creators' affiliate links intact. Open source, no data selling."

/** Detailed description for the store dashboards (plain text, no markdown). */
export const DESCRIPTION = `Caramel finds coupon codes for the store you're shopping on and tries them on your cart for you, so you stop copying and pasting codes one by one.

• Auto-apply at checkout: on supported stores, Caramel shows a small prompt at checkout. Tap it and Caramel tries up to 8 codes on your cart. On many stores it compares them and keeps the lowest total; on others it stops at the first code that works.
• Savings you can trust: when a code works, Caramel shows what you saved, read from the store's own cart total. When no code works, it tells you so.
• Creators keep their commission: Caramel has no affiliate code. It never adds, replaces or removes referral links or cookies, so the creator who sent you keeps the credit.
• No data selling: Caramel doesn't sell your data, only talks to grabcaramel.com, and works without an account.
• Open source: the full code is public under the AGPL-3.0 license at github.com/DevinoSolutions/caramel.

How it works
1. Install Caramel and shop as usual.
2. The toolbar badge shows how many codes Caramel has for the site you're on.
3. At checkout, tap "Try Caramel Coupons". Caramel tries the codes on your cart and keeps the one that saves you money.
4. Prefer to pick a code yourself? Open the Caramel popup to see the codes for the site and copy one.

You stay in control: in Caramel's settings, pause the checkout prompt on any site or turn it off everywhere.

Caramel is free and works on Chrome, Firefox, Edge and Safari. It doesn't offer cashback or rewards: it finds coupon codes and applies them for you.`
