// lib/codeShapedTokens.ts
//
// ONE pure redaction rule for text that may carry a shopper's own coupon code
// (T-9959: code-adjacent text must not be stored or forwarded without consent).
// Stores print "X cannot be combined with MYCODE5"; a cart or outline row can
// read "Discount: SAVE10" or "Remove SAVE10". The server cannot ask the shopper
// whether a code is theirs, so it redacts by SHAPE and CONTEXT.
//
// Before anything else, invisible format characters (zero-width space/joiners,
// word joiner, BOM, soft hyphen, directional marks: Unicode category Cf) are
// STRIPPED, so "save<ZWSP>10" cannot hide a code from the tokenizer.
//
// A TOKEN is a maximal run of letters, digits and `#` (any script) that may
// contain `-` or `_` inside it, e.g. `FALL20`, `SAVE-10`, `30-day`, `SAVE##`.
// (`#` is what the extension's digit mask leaves behind, so an already-masked
// "Remove SAVE##" is still a code.) Tokens shorter than 3 characters are never
// touched. A token becomes REDACTED_CODE ("[code]") when
//   (1) it MIXES letters with digits or `#` ("SAVE10", "10OFF", "50off",
//       "30-day", "SAVE##"), except an ordinal ("1st", "22nd"); or
//   (2) only when `contextualCaps` is on (store reasons): it is an
//       alphabetic ALL-CAPS token of 3+ letters that is QUOTED ("MYCODE") or
//       comes right after code / coupon / promo / voucher, optionally with ':'
//       or a quote ("code MYCODE is invalid"), and is not a common word
//       (CONTEXT_ALLOWLIST). A whole uppercase message ("MINIMUM SPEND NOT
//       MET") has no such context and is left intact.
// Pure numbers and amounts are kept: "$50", "20%", "2026", "1,000", "5-7 days".
// The catalog code being discussed (`keepCode`) survives only as a COMPLETE,
// boundary-delimited, case-insensitive occurrence of the whole code; its
// constituent tokens get no protection on their own.
//
// KNOWN LIMITS, by design: 2-character tokens and ordinals are not touched, and
// a code split by spaces or dots ("save 10") is not joined: real codes carry no
// separators and joining tokens would mangle product text. A code that is
// neither mixed nor in the contextual position ("Welcome") has no shape to
// recognise and passes through.

const REDACTED_CODE = '[code]'

/** Words that may legitimately follow "code"/"coupon" or sit in quotes, in caps. */
const CONTEXT_ALLOWLIST: ReadonlySet<string> = new Set(
    (
        'USD CAD EUR GBP FREE SALE OFF CODE CODES COUPON COUPONS PROMO PROMOTION VOUCHER DISCOUNT ' +
        'NOT CANNOT CAN IS ARE WAS HAS HAVE BEEN THE THIS THAT THESE FOR AND WITH ' +
        'ANY ALL ONLY ALREADY USED APPLIED APPLICABLE AVAILABLE UNAVAILABLE EXPIRED ' +
        'INVALID VALID INACTIVE ACTIVE REQUIRED ENTERED FOUND RECOGNIZED RECOGNISED ' +
        'ACCEPTED SUPPORTED ELIGIBLE INELIGIBLE MET REACHED TOO MUST WILL YOUR THAN MORE ' +
        'LESS UNABLE FAILED ERROR SORRY PLEASE TRY AGAIN REMOVED LIMIT EXCEEDED REDEEMED ' +
        'EXHAUSTED REJECTED DECLINED MISSING EMPTY'
    ).split(' '),
)

// Built with the constructor because this project's compile target rejects the
// literal `u` flag (same reason as couponBoxPick.ts); every runtime supports it.
const FORMAT_CHARS = new RegExp('\\p{Cf}', 'gu')
const TOKEN = new RegExp(
    '[\\p{L}\\p{N}#](?:[\\p{L}\\p{N}_#-]*[\\p{L}\\p{N}#])?',
    'gu',
)
const HAS_LETTER = new RegExp('\\p{L}', 'u')
const HAS_DIGIT_OR_MASK = new RegExp('[\\p{N}#]', 'u')
const ORDINAL = /^\d+(?:st|nd|rd|th)$/i
const NON_LETTERS = new RegExp('[^\\p{L}]', 'gu')

const CAPS_TOKEN = '\\p{Lu}(?:[\\p{Lu}_-]*\\p{Lu})?'
const NOT_TOKEN_BEFORE = '(?<![\\p{L}\\p{N}_#-])'
const NOT_TOKEN_AFTER = '(?![\\p{L}\\p{N}_#-])'
// The context words match in ANY case ("cOUPON MYCODE"), spelled as per-letter
// classes because the `i` flag would make \p{Lu} match lowercase too, and the
// candidate's own all-caps shape must still be checked.
const CONTEXT_WORDS = ['code', 'coupon', 'promo', 'voucher']
    .map(w =>
        w
            .split('')
            .map(c => `[${c}${c.toUpperCase()}]`)
            .join(''),
    )
    .join('|')
const OPEN_QUOTES = '"“‘«\'`'
const CLOSE_QUOTES = '"”’»\'`'
// Lookbehinds, not consumed context: in "COUPON CODE MYCODE" both CODE (kept,
// allowlisted) and MYCODE must be examined.
const AFTER_CONTEXT_WORD = new RegExp(
    `(?<=(?:^|[^\\p{L}\\p{N}])(?:${CONTEXT_WORDS})\\s{0,3}[:${OPEN_QUOTES}]?\\s{0,3})` +
        `${NOT_TOKEN_BEFORE}(${CAPS_TOKEN})${NOT_TOKEN_AFTER}`,
    'gu',
)
const QUOTED = new RegExp(
    `(?<=[${OPEN_QUOTES}]\\s{0,2})${NOT_TOKEN_BEFORE}(${CAPS_TOKEN})(?=\\s{0,2}[${CLOSE_QUOTES}])`,
    'gu',
)

const MIN_TOKEN_LENGTH = 3
const MIN_CAPS_LETTERS = 3

interface CodeRedactionOptions {
    /** Also redact quoted / code-adjacent ALL-CAPS tokens (rule 2). Default false. */
    contextualCaps?: boolean
    /** The catalog code under discussion; whole occurrences of it survive. */
    keepCode?: string | null
}

/** `text` without invisible format characters (zero-width, BOM, joiners...). */
export function stripFormatChars(text: string): string {
    return text.replace(FORMAT_CHARS, '')
}

function isMixedToken(token: string): boolean {
    return (
        HAS_LETTER.test(token) &&
        HAS_DIGIT_OR_MASK.test(token) &&
        !ORDINAL.test(token)
    )
}

function redactMixedTokens(text: string): string {
    return text.replace(TOKEN, token =>
        token.length >= MIN_TOKEN_LENGTH && isMixedToken(token)
            ? REDACTED_CODE
            : token,
    )
}

function redactCapsToken(token: string): string {
    return token.replace(NON_LETTERS, '').length >= MIN_CAPS_LETTERS &&
        !CONTEXT_ALLOWLIST.has(token)
        ? REDACTED_CODE
        : token
}

function redactContextualCaps(text: string): string {
    return text
        .replace(AFTER_CONTEXT_WORD, redactCapsToken)
        .replace(QUOTED, redactCapsToken)
}

function redactSegment(text: string, contextualCaps: boolean): string {
    const mixed = redactMixedTokens(text)
    return contextualCaps ? redactContextualCaps(mixed) : mixed
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `text` with every code-shaped token replaced by REDACTED_CODE. */
export function redactCodeShapedTokens(
    text: string,
    options: CodeRedactionOptions = {},
): string {
    const clean = stripFormatChars(text)
    const contextualCaps = options.contextualCaps === true
    const keep = stripFormatChars(options.keepCode ?? '').trim()
    if (keep === '') return redactSegment(clean, contextualCaps)

    // Split around whole, boundary-delimited occurrences of the catalog code:
    // odd entries are the kept occurrences, even entries get redacted.
    const whole = new RegExp(
        `${NOT_TOKEN_BEFORE}(${escapeRegExp(keep)})${NOT_TOKEN_AFTER}`,
        'giu',
    )
    return clean
        .split(whole)
        .map((part, index) =>
            index % 2 === 1 ? part : redactSegment(part, contextualCaps),
        )
        .join('')
}

/** True when redacting `text` (with no catalog code to keep) would change it. */
export function hasCodeShapedToken(
    text: string,
    options: Pick<CodeRedactionOptions, 'contextualCaps'> = {},
): boolean {
    return redactCodeShapedTokens(text, options) !== text
}

/**
 * A failure reason the STORE wrote (cut to 200 chars by the report route),
 * redacted with the full rule (mixed tokens AND contextual caps) except whole
 * occurrences of the catalog code being reported. `catalogCode` is null when the
 * coupon is not a catalog row (nothing is stored then, so nothing needs keeping).
 */
export function redactStoreReason(
    reason: string,
    catalogCode: string | null,
): string {
    return redactCodeShapedTokens(reason, {
        contextualCaps: true,
        keepCode: catalogCode,
    })
}
