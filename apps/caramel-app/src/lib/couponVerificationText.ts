// lib/couponVerificationText.ts
//
// What a shopper may read of a coupon's `verification_message`.
//
// The column is written by the coupons verifier (the Python producer) and is
// mostly its own log text. Prod, 2026-09-26, visible coupons only:
//   retry  34,102 rows: "Verification timed out after 120s" (10,503),
//          "API request failed: … curl: (56) CONNECT tunnel failed …",
//          "Headful browser launch failed", "Coupon input selector was not
//          found on https://…"
//   valid  19,463 rows: "Discount code accepted (Shopify cart.json; cart 1
//          item / 45 USD)", "Coupon accepted (structural discriminator)",
//          "Discount code classified as valid (HTML+LLM)"
//   product_restriction 1,728 rows: "basket.error.bagNotFound",
//          "NO_ITEMS_QUALIFY", "code accepted (not rejected as invalid) but
//          produced no discount on the seeded c…", next to real store
//          sentences such as "Your cart contains ineligible products."
// The extension popup prints the message under every restricted coupon and
// both coupon cards put it in the badge tooltip, so all of that reached
// shoppers. Every read that serves coupons (couponsRepo) now passes the text
// through shopperVerificationText. Only a restricted coupon keeps a message,
// because only there does it explain something to the shopper (why the code
// may not apply to their cart); on 'valid'/'retry'/'pending' it is the
// verifier's own log or whatever the store page printed (newsletter popups,
// "Email is a required field."). Even then it is kept only when it reads as
// a sentence written for a person, normally the store's own words. Otherwise
// it becomes null and the cards fall back to the status label and the
// restriction line they already show.

import { isRestrictedStatus } from '@/lib/coupons'

/** Verifier and transport vocabulary that never belongs in front of a shopper. */
const ENGINEER_MARKERS: readonly RegExp[] = [
    /cart\.json/i,
    /\b(html|llm|api|http|https|curl|proxy|tunnel|endpoint|selector|headful|headless|session|seeded|discriminator|timeout|null|undefined|exception|stack)\b/i,
    /timed out/i,
    /verif/i, // "verification", "Could not fully verify": the verifier talking about itself
    /\bstatus \d/i,
    /unable to classify/i,
    /\berror \d/i,
    /&#?\w+;/, // an undecoded HTML entity: can&#039;t
    /\$0(\.00)?\b/, // "current cart is $0": the verifier's cart
    // The store answering the verifier's own seeded cart, not the shopper's.
    /\b(cart|basket|bag) (is|was) (currently )?empty\b/i,
    /\bno items in (your |the )?(shopping )?(cart|basket|bag)\b/i,
    /\b(does not|doesn't) contain (any )?products\b/i,
    /\badd items to (your |the )?(cart|basket|bag)\b/i,
    /\b\w+\.\w+\.\w+/, // dotted keys: basket.error.bagNotFound, a.b.c
    /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/, // snake/SCREAMING case codes: NO_ITEMS_QUALIFY
    /[{}<>[\]=|\\]/, // markup, JSON, key=value
    /^\s*(error|warn|info|debug)\b\s*:/i,
]

const MIN_LENGTH = 12
const MAX_LENGTH = 280

/**
 * The message a shopper may see for a coupon in `status`, or null.
 *
 * Kept only for a restricted status, and only when it is a sentence addressed
 * to a person: starts with a capital letter, fits a tooltip, has at least
 * four words (three if it ends with . ! or ?), and carries none of the
 * verifier's vocabulary. Conservative on purpose: dropping a real store
 * sentence costs a tooltip, showing a log line costs the shopper's trust.
 */
export function shopperVerificationText(
    status: string,
    message: string | null | undefined,
): string | null {
    if (!message || !isRestrictedStatus(status)) return null
    const text = message.replace(/\s+/g, ' ').trim()
    if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return null
    // An uppercase letter in any script (a digit or symbol has no lowercase).
    if (text[0] === text[0].toLowerCase()) return null
    const words = text.split(' ').length
    if (words < (/[.!?]$/.test(text) ? 3 : 4)) return null
    if (ENGINEER_MARKERS.some(marker => marker.test(text))) return null
    return text
}
