// lib/cartItemScrub.ts
//
// What POST /api/classify-cart forwards to the LLM from the extension's
// `cart_items` (cartClassifier.ts sends them verbatim). A cart row is meant to
// be a product title, but a page can render an applied-discount line ("Discount:
// SAVE10") as a row, and that carries a shopper's code (T-9959). Two steps, both
// server-side so old extension builds are covered:
//   1. a row that READS like a discount line is dropped whole: a label word
//      (discount, coupon, promo, voucher, savings; whole words, so "Promontory"
//      stays) together with an amount ("$5", "10%"), a minus sign ("-5") or a
//      code token (a letters+digits token, or "Label: SHOUTED"); or the phrase
//      "code applied". "Coupon organizer" and "Savings planner" are products.
//      A product row that also prints its price next to such a word is dropped
//      too: losing one cart row costs the classifier nothing, a leaked code does;
//   2. in the remaining titles, any token mixing letters and digits becomes
//      "[code]" (codeShapedTokens.ts; shouted words stay, product titles are
//      full of them).
import {
    redactCodeShapedTokens,
    stripFormatChars,
} from '@/lib/codeShapedTokens'

const LABEL = /\b(?:discounts?|coupons?|promo(?:tion)?s?|vouchers?|savings?)\b/i
const CODE_APPLIED = /\bcode\s+applied\b/i
const AMOUNT = new RegExp(
    '[$€£¥]\\s?\\d|\\d[\\d.,]*\\s?(?:%|[$€£¥])|(?:^|\\s)[-−–]\\s?[$€£¥]?\\d',
    'u',
)
const MIXED_TOKEN = new RegExp(
    '(?=[\\p{L}\\p{N}#_-]*\\p{L})(?=[\\p{L}\\p{N}#_-]*[\\p{N}#])[\\p{L}\\p{N}#][\\p{L}\\p{N}#_-]{2,}',
    'u',
)
const LABEL_COLON_TOKEN =
    /\b(?:discounts?|coupons?|promo(?:tion)?s?|vouchers?|savings?)\s*[:#]\s*(\S{3,})/i
const SHOUTED = new RegExp('^\\p{Lu}[\\p{Lu}\\p{N}_-]{2,}$', 'u')

function labelsAShoutedToken(item: string): boolean {
    const token = LABEL_COLON_TOKEN.exec(item)?.[1]
    return token !== undefined && SHOUTED.test(token)
}

function isDiscountLine(item: string): boolean {
    if (CODE_APPLIED.test(item)) return true
    if (!LABEL.test(item)) return false
    return (
        AMOUNT.test(item) || MIXED_TOKEN.test(item) || labelsAShoutedToken(item)
    )
}

/** Cart rows safe to forward: discount lines dropped, code-shaped tokens redacted. */
export function scrubCartItems(items: readonly string[]): string[] {
    return items
        .map(stripFormatChars)
        .filter(item => !isDiscountLine(item))
        .map(item => redactCodeShapedTokens(item))
}
