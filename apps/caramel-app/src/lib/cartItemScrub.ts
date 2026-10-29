// lib/cartItemScrub.ts
//
// What POST /api/classify-cart forwards to the LLM from the extension's
// `cart_items` (cartClassifier.ts sends them verbatim). A cart row is meant to
// be a product title, but a page can render an applied-discount line ("Discount:
// SAVE10") as a row, and that carries a shopper's code (T-9959). Two steps, both
// server-side so old extension builds are covered:
//   1. a row that is a discount line BY STRUCTURE is dropped whole. It starts
//      (after optional bullets) with a discount label (discount, coupon, promo,
//      voucher, savings, code, "coupon code", "promo code", "you saved") that is
//      immediately followed by ':' or a spaced dash, by a NEGATIVE or
//      parenthesised amount ("-$5.00", "($5.00)", "-5%"), or by a code-like token
//      and applied / removed / redeemed. Also dropped: a row that is only a
//      negative amount, one that says "applied" next to a code / coupon / promo /
//      voucher / discount word, and "You saved <amount>" (it holds no code, so
//      dropping it costs nothing and keeps the rule uniform).
//      A label word elsewhere or with a price ("Savings planner $12.99",
//      "Coupon organizer - $8", "Promontory hiking boots $89") is a product and
//      stays;
//   2. in the remaining titles, any token mixing letters and digits becomes
//      "[code]" (codeShapedTokens.ts; shouted words stay, product titles are
//      full of them).
import {
    redactCodeShapedTokens,
    stripFormatChars,
} from '@/lib/codeShapedTokens'

const LABEL =
    '(?:coupon\\s+code|promo\\s+code|discount\\s+code|discounts?|coupons?|promotions?|promo|vouchers?|savings?|you\\s+saved|code)'
const BULLETS = '[\\s•·▪●*]*'
const AMOUNT_START = '[$€£¥]?\\s?\\d'
// ':' right after the label, or a dash set off by whitespace ("Promo-pack" is a
// product); a negative / parenthesised amount; a code-like token then a verb.
const STARTS_WITH_LABEL = new RegExp(
    `^${BULLETS}${LABEL}\\b(?:\\s*:|\\s+[-–−]|\\s*[-–−]\\s?${AMOUNT_START}|\\s*\\(\\s?${AMOUNT_START})`,
    'iu',
)
const LABEL_TOKEN_VERB = new RegExp(
    `^${BULLETS}${LABEL}\\b\\s+(\\S+)\\s+(?:applied|removed|redeemed)\\b`,
    'iu',
)
const YOU_SAVED_AMOUNT = new RegExp(
    `^${BULLETS}you\\s+saved\\s*${AMOUNT_START}`,
    'iu',
)
const ONLY_NEGATIVE_AMOUNT = new RegExp(
    '^\\s*(?:[-–−]\\s?[$€£¥]?\\s?\\d[\\d.,]*\\s?[%$€£¥]?|\\(\\s?[$€£¥]?\\s?\\d[\\d.,]*\\s?[%$€£¥]?\\s?\\))\\s*$',
    'u',
)
const APPLIED = /\bapplied\b/i
const DISCOUNT_WORD = /\b(?:code|coupon|promo|voucher|discount)\b/i

const CODE_LIKE = new RegExp(
    '^(?=[\\p{L}\\p{N}#_-]*\\p{L})(?=[\\p{L}\\p{N}#_-]*[\\p{N}#])[\\p{L}\\p{N}#_-]{3,}[!.,;]?$|^\\p{Lu}[\\p{Lu}_-]{2,}[!.,;]?$',
    'u',
)

function isDiscountLine(item: string): boolean {
    if (STARTS_WITH_LABEL.test(item)) return true
    if (YOU_SAVED_AMOUNT.test(item)) return true
    if (ONLY_NEGATIVE_AMOUNT.test(item)) return true
    if (APPLIED.test(item) && DISCOUNT_WORD.test(item)) return true
    const token = LABEL_TOKEN_VERB.exec(item)?.[1]
    return token !== undefined && CODE_LIKE.test(token)
}

/** Cart rows safe to forward: discount lines dropped, code-shaped tokens redacted. */
export function scrubCartItems(items: readonly string[]): string[] {
    return items
        .map(stripFormatChars)
        .filter(item => !isDiscountLine(item))
        .map(item => redactCodeShapedTokens(item))
}
