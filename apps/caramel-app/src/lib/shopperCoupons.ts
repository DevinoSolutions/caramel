// lib/shopperCoupons.ts
//
// The pure vocabulary of shopper-submitted coupon codes: signed-in shoppers add
// codes to the app-owned `coupons` catalog, either captured at checkout by the
// extension (source 'checkout') or typed into the store page (source 'manual').
// No DB, no server-only imports: the form, the route and the repo all share it.
//
// Reserved id range. Shopper rows take their id from the Postgres sequence
// `shopper_coupon_id_seq` (migration 20261002120000_shopper_coupon_submissions),
// which starts at SHOPPER_COUPON_ID_FLOOR. The supplier's ingest schema
// (catalog/ingestSchemas.ts) refuses any id at or above the floor, so a supplier
// push can never overwrite a shopper row under the only-if-newer upsert. The
// floor is also the one number the SQL migration and the ingest guard must
// agree on: change it in all three places or not at all.
//
// The extension's code-capture.js cannot import this file (no bundler), so it
// mirrors SHOPPER_CODE_PATTERN and looksLikeCardNumber; tests/unit/shopper-code-pattern-mirror.test.ts
// fails if the two ever differ.

/**
 * First id of the reserved shopper range (inclusive). The sequence starts here.
 * BigInt(), not a `n` literal: the tsconfig target predates ES2020 literals.
 */
export const SHOPPER_COUPON_ID_FLOOR = BigInt('900000000000000000')

/**
 * What a shopper-submitted code may look like: 3 to 40 characters, starting with
 * a letter or digit, then letters, digits, underscore or hyphen. Deliberately
 * narrower than what some stores issue (no spaces, no punctuation): a code that
 * fails this is far more likely to be typed prose than a coupon, and the value
 * is rendered on public store pages and in JSON-LD.
 */
export const SHOPPER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/

/** Per-shopper submissions allowed in any rolling 24 hours (new rows only; a duplicate is free). */
export const SHOPPER_DAILY_SUBMISSION_CAP = 20

/** Where a submission came from: the extension's checkout capture, or the website form. */
export type ShopperSubmissionSource = 'checkout' | 'manual'

/**
 * The lowest extension consent-prompt version whose "yes" the server accepts as
 * proof for a `source: 'checkout'` submission. The extension records
 * `{ choice, at, promptVersion }` locally (code-sharing-consent.js) and sends it
 * with every checkout capture; POST /api/coupons/submit refuses (403
 * `consent-required`) a checkout submission whose proof is missing, is not
 * 'accepted', or carries a smaller version. Raise it ONLY when the prompt's
 * meaning changes (the extension then re-asks every shopper at the same time).
 * The extension package cannot be imported here, so this mirrors its
 * CODE_SHARING_PROMPT_VERSION by hand; checkout-consent-version-mirror.test.ts
 * fails if this floor ever exceeds the version the extension sends.
 */
export const MIN_CHECKOUT_CONSENT_PROMPT_VERSION = 1

/**
 * The `description` every shopper row carries. The `title` is stored empty on
 * purpose: shopperCouponTitle (couponTitleText.ts) derives "<site> promo code
 * CODE" at read time, so the wording can improve without a data migration.
 */
export const SHOPPER_COUPON_DESCRIPTION = 'Shared by a Caramel shopper.'

/**
 * True when a string has the SHAPE of a payment-card or gift-card number rather
 * than a coupon code: all digits and 8 or more long, or 16 or more characters
 * holding 12 or more digits (a card number written with hyphens). The checkout
 * capture reads a field the shopper typed into, and a gift-card or card number
 * typed into a look-alike promo box must never be shared, so this is refused at
 * the door of every path that stores a code. Real coupon codes with that many
 * digits are rare enough that refusing them is the right trade.
 *
 * Self-contained on purpose: the extension's code-capture.js mirrors this body
 * (no bundler), and tests/unit/shopper-code-pattern-mirror.test.ts runs both
 * against the same inputs. Change both together.
 */
export function looksLikeCardNumber(code: string): boolean {
    if (/^[0-9]{8,}$/.test(code)) return true
    const digits = code.replace(/[^0-9]/g, '').length
    return code.length >= 16 && digits >= 12
}

/**
 * Trim and validate a typed or captured code. Returns the code exactly as the
 * shopper typed it (case is NEVER changed: some stores treat codes as
 * case-sensitive), or null when it is not a plausible coupon code (wrong
 * characters or length, or the shape of a card number).
 */
export function normalizeShopperCode(raw: string): string | null {
    const code = raw.trim()
    if (!SHOPPER_CODE_PATTERN.test(code)) return null
    return looksLikeCardNumber(code) ? null : code
}

/**
 * Thrown by submitShopperCoupon when the store is not one Caramel knows: no
 * supplier-sourced coupon and no store_configs row for the base. Without this
 * gate one shopper row would make /coupons/<any-registrable-domain> indexable
 * and put it in the sitemap. The route maps it to 422 `{ error: 'not-a-store' }`.
 * Carries no store name: the base is untrusted input and can reach Sentry.
 */
export class UnknownStoreError extends Error {
    constructor() {
        super('Shopper submission refused: the store is not a known store')
        this.name = 'UnknownStoreError'
    }
}

/**
 * Thrown by submitShopperCoupon when the shopper already added
 * SHOPPER_DAILY_SUBMISSION_CAP new codes in the last 24 hours. The route maps it
 * to 429 `{ error: 'daily-limit' }`. Carries the cap, never the user's id: it
 * can reach Sentry through a generic handler.
 */
export class ShopperSubmissionLimitError extends Error {
    readonly cap: number

    constructor(cap: number = SHOPPER_DAILY_SUBMISSION_CAP) {
        super(`Shopper reached the daily limit of ${cap} submitted codes`)
        this.name = 'ShopperSubmissionLimitError'
        this.cap = cap
    }
}
