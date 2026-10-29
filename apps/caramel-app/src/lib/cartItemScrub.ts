// lib/cartItemScrub.ts
//
// What POST /api/classify-cart forwards to the LLM from the extension's
// `cart_items` (cartClassifier.ts sends them verbatim). A cart row is meant to
// be a product title, but a page can render an applied-discount line ("Discount:
// SAVE10") as a row, and that carries a shopper's code (T-9959). Two steps, both
// server-side so old extension builds are covered:
//   1. a row that speaks of discounts at all is dropped whole;
//   2. in the remaining titles, any token mixing letters and digits becomes
//      "[code]" (codeShapedTokens.ts; shouted words stay, product titles are
//      full of them).
import { redactCodeShapedTokens } from '@/lib/codeShapedTokens'

const DISCOUNT_VOCABULARY =
    /discount|coupon|promo|voucher|code applied|savings/i

/** True when a cart row reads like an applied-discount line, not a product. */
function isDiscountLine(item: string): boolean {
    return DISCOUNT_VOCABULARY.test(item)
}

/** Cart rows safe to forward: discount lines dropped, code-shaped tokens redacted. */
export function scrubCartItems(items: readonly string[]): string[] {
    return items
        .filter(item => !isDiscountLine(item))
        .map(item => redactCodeShapedTokens(item))
}
