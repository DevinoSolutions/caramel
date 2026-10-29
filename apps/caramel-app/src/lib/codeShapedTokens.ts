// lib/codeShapedTokens.ts
//
// ONE pure redaction rule for text that may carry a shopper's own coupon code
// (T-9959: code-adjacent text must not be stored or forwarded without consent).
// Stores print "X cannot be combined with MYCODE5"; a cart or outline row can
// read "Discount: SAVE10" or "Remove SAVE10". The server cannot ask the shopper
// whether a code is theirs, so it redacts by SHAPE.
//
// A TOKEN is a maximal run of letters/digits (any script) that may contain `-`
// or `_` inside it, e.g. `FALL20`, `SAVE-10`, `30-day`. Tokens shorter than 3
// characters are never touched. A token becomes REDACTED_CODE ("[code]") when it
//   (1) MIXES letters and digits ("SAVE10", "10OFF", "50off", "30-day"), except
//       an ordinal ("1st", "22nd", "3rd", "4th"); or
//   (2) only when `shoutingWords` is on: is SHOUTED, i.e. every character is an
//       uppercase letter (or `-`/`_`), it has 4+ letters, and it is not one of
//       SHOUTING_ALLOWLIST ("MYCODE", "SAVE-NOW", "T-SHIRT" are redacted;
//       "USD", "FREE", "SALE", "OFF", "CODE" are not).
// Pure numbers and amounts are kept: "$50", "20%", "2026", "1,000", "5-7 days".
// A token that equals one of the tokens of `keepCode` (the catalog code being
// talked about, compared case-insensitively) is always kept.
//
// KNOWN LIMIT, by design: a code that is neither mixed nor shouted ("Welcome",
// "summer") has no shape to recognise and passes through. Rule (2) is off for
// outlines and cart rows because page text is full of legitimate uppercase
// labels ("APPLY", "ORDER SUMMARY", "NIKE AIR MAX"); rule (1) alone applies there.

const REDACTED_CODE = '[code]'

/** Uppercase words a store error legitimately shouts; kept even under rule (2). */
const SHOUTING_ALLOWLIST: ReadonlySet<string> = new Set([
    'USD',
    'CAD',
    'EUR',
    'GBP',
    'FREE',
    'SALE',
    'OFF',
    'CODE',
    'COUPON',
    'EXPIRED',
    'INVALID',
    'VALID',
])

// Built with the constructor because this project's compile target rejects the
// literal `u` flag (same reason as couponBoxPick.ts); every runtime supports it.
const TOKEN = new RegExp(
    '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}])?',
    'gu',
)
const HAS_LETTER = new RegExp('\\p{L}', 'u')
const HAS_DIGIT = new RegExp('\\p{N}', 'u')
const SHOUTED = new RegExp('^\\p{Lu}[\\p{Lu}_-]*$', 'u')
const ORDINAL = /^\d+(?:st|nd|rd|th)$/i
const NON_LETTERS = new RegExp('[^\\p{L}]', 'gu')

const MIN_TOKEN_LENGTH = 3
const MIN_SHOUTED_LETTERS = 4

interface CodeRedactionOptions {
    /** Also redact SHOUTED words (rule 2). Default false: mixed tokens only. */
    shoutingWords?: boolean
    /** The catalog code under discussion; its own tokens survive. */
    keepCode?: string | null
}

function tokensOf(text: string): string[] {
    return text.match(TOKEN) ?? []
}

function isMixedToken(token: string): boolean {
    return (
        HAS_LETTER.test(token) && HAS_DIGIT.test(token) && !ORDINAL.test(token)
    )
}

function isShoutedToken(token: string): boolean {
    return (
        SHOUTED.test(token) &&
        token.replace(NON_LETTERS, '').length >= MIN_SHOUTED_LETTERS &&
        !SHOUTING_ALLOWLIST.has(token.toUpperCase())
    )
}

/** `text` with every code-shaped token replaced by REDACTED_CODE. */
export function redactCodeShapedTokens(
    text: string,
    options: CodeRedactionOptions = {},
): string {
    const kept = new Set(
        tokensOf(options.keepCode ?? '').map(token => token.toUpperCase()),
    )
    return text.replace(TOKEN, token => {
        if (token.length < MIN_TOKEN_LENGTH) return token
        if (kept.has(token.toUpperCase())) return token
        if (isMixedToken(token)) return REDACTED_CODE
        if (options.shoutingWords === true && isShoutedToken(token)) {
            return REDACTED_CODE
        }
        return token
    })
}

/** True when redacting `text` (with no catalog code to keep) would change it. */
export function hasCodeShapedToken(
    text: string,
    options: Pick<CodeRedactionOptions, 'shoutingWords'> = {},
): boolean {
    return redactCodeShapedTokens(text, options) !== text
}

/**
 * A failure reason the STORE wrote (cut to 200 chars by the report route),
 * redacted with the full rule (mixed AND shouted tokens) except the catalog
 * code being reported. `catalogCode` is null when the coupon is not a catalog
 * row (nothing is stored then, so nothing needs keeping).
 */
export function redactStoreReason(
    reason: string,
    catalogCode: string | null,
): string {
    return redactCodeShapedTokens(reason, {
        shoutingWords: true,
        keepCode: catalogCode,
    })
}
