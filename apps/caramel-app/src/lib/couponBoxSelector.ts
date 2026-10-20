// src/lib/couponBoxSelector.ts
//
// The selector grammar a learned coupon box may use: the ONE home of the rule
// POST /api/extension/coupon-box-learned enforces, and the grammar the
// extension emits and accepts. A learned box is crowd-sourced, so its
// selectors are untrusted input that other shoppers' browsers will run
// `querySelector` on: the grammar is a small allowlist rather than "any CSS",
// and anything outside it is refused whole.
//
//   selector   := compound ( combinator compound ){0,3}   at most 4 compounds
//   combinator := whitespace | ws? ( '>' | '+' | '~' ) ws?
//   compound   := ( type | '*' )? part*                  at least one item
//   type       := [A-Za-z][A-Za-z0-9-]*
//   part       := '#' ident | '.' ident | attr | pseudo
//   ident      := '-'? [A-Za-z_] [A-Za-z0-9_-]*
//   attr       := '[' name ( op value )? ']'               no spaces inside
//   name       := 'id' | 'name' | 'type' | 'aria-label' | 'placeholder'
//               | 'data-' [a-z0-9-]+
//   op         := '=' | '^=' | '$=' | '*='
//   value      := '"' plain '"' | ident
//   plain      := 0-100 characters, none of  " ' \ [ ] { } ; <  or a control
//                 character
//   pseudo     := ':first-child' | ':last-child' | ':first-of-type'
//               | ':last-of-type' | ':only-of-type'
//               | ':nth-child(' n ')' | ':nth-of-type(' n ')'   n = 1-99
//               | ':not(' simple ')'
//   simple     := type | '#' ident | '.' ident | attr
//
// Plus: at most 3 attribute selectors in the whole selector (those inside
// `:not(...)` count), at most 256 characters, and never `javascript:`, `url(`
// or `expression` anywhere. So no selector lists (`,`), no `:has(`, no
// `:nth-last-*`, no pseudo-elements, no escapes, no comments.
//
// And nothing that looks like data about a person (holdsPersonalData): no
// `@` (or `%40`) anywhere, which is how an email address would appear, and in
// an attribute value (other than `id`) no number of 6 or more digits, even
// split by spaces, dashes or dots, which is how a phone, card, order or
// account number would (`[data-phone="555-123-4567"]`). A store's markup can
// carry such data (`[data-customer-email="..."]`). Ids and classes may hold
// long numbers: stores generate them (`#shopify-section-template--1671...`),
// and they name an element rather than carry a value. A real coupon box is
// found without such values; a selector that needs one is refused whole.

const MAX_CHARS = 256
const MAX_COMPOUNDS = 4
const MAX_ATTRIBUTES = 3

const IDENT = '-?[A-Za-z_][A-Za-z0-9_-]*'
const TYPE_RE = /^(?:[A-Za-z][A-Za-z0-9-]*|\*)/
const ID_OR_CLASS_RE = new RegExp(`^[#.]${IDENT}`)
// Built with the constructor: this project's compile target rejects a literal
// `u` flag. \p{Cc} = every control character, not only ASCII ones.
const ATTR_RE = new RegExp(
    '^\\[(?:id|name|type|aria-label|placeholder|data-[a-z0-9-]+)' +
        `(?:(?:=|\\^=|\\$=|\\*=)(?:"[^"'\\\\\\[\\]{};<\\p{Cc}]{0,100}"|${IDENT}))?\\]`,
    'u',
)
const PLAIN_PSEUDO_RE =
    /^:(?:first-child|last-child|first-of-type|last-of-type|only-of-type)(?![A-Za-z0-9_(-])/
const NTH_PSEUDO_RE = /^:(?:nth-child|nth-of-type)\([1-9][0-9]?\)/
const FORBIDDEN_RE = /javascript:|url\s*\(|expression/i
const EMAIL_SIGN_RE = /@|%40/i
// 6 or more digits, which a page may group with spaces, dashes or dots.
const LONG_NUMBER_RE = /[0-9](?:[ .-]*[0-9]){5,}/
// An attribute selector with a value, once the grammar has accepted it.
const ATTR_VALUE_RE = /\[([a-z0-9-]+)[$^*]?=("[^"]*"|[A-Za-z0-9_-]+)\]/

interface Cursor {
    s: string
    i: number
    attributes: number
}

function take(c: Cursor, re: RegExp): string | null {
    const m = re.exec(c.s.slice(c.i))
    if (!m) return null
    c.i += m[0].length
    return m[0]
}

/** type | #id | .class | attr — the one item `:not(...)` may hold. */
function simple(c: Cursor): boolean {
    if (take(c, ID_OR_CLASS_RE)) return true
    if (take(c, ATTR_RE)) {
        c.attributes += 1
        return true
    }
    return take(c, TYPE_RE) !== null
}

function compound(c: Cursor): boolean {
    const start = c.i
    take(c, TYPE_RE)
    for (;;) {
        if (take(c, ID_OR_CLASS_RE)) continue
        if (take(c, ATTR_RE)) {
            c.attributes += 1
            continue
        }
        if (take(c, PLAIN_PSEUDO_RE) || take(c, NTH_PSEUDO_RE)) continue
        if (c.s.startsWith(':not(', c.i)) {
            c.i += ':not('.length
            if (!simple(c) || c.s[c.i] !== ')') return false
            c.i += 1
            continue
        }
        break
    }
    return c.i > start
}

/** The selector's compounds in order (`form.a button[x]` -> `form.a`,
 * `button[x]`), or null when it is outside the grammar above. */
function compoundsOf(selector: string): string[] | null {
    if (selector.length === 0 || selector.length > MAX_CHARS) return null
    if (FORBIDDEN_RE.test(selector)) return null
    const c: Cursor = { s: selector, i: 0, attributes: 0 }
    const compounds: string[] = []
    for (;;) {
        const start = c.i
        if (!compound(c)) return null
        compounds.push(selector.slice(start, c.i))
        if (compounds.length > MAX_COMPOUNDS) return null
        if (c.attributes > MAX_ATTRIBUTES) return null
        if (c.i === c.s.length) return compounds
        const spaces = take(c, /^ +/)
        const combinator = take(c, /^[>+~] */)
        if (!spaces && !combinator) return null
        if (c.i === c.s.length) return null
    }
}

/** An `@` anywhere, or a long number in an attribute value other than `id`.
 * Call it on a selector inside the grammar. */
function holdsPersonalData(selector: string): boolean {
    if (EMAIL_SIGN_RE.test(selector)) return true
    const values = new RegExp(ATTR_VALUE_RE.source, 'g')
    for (let m = values.exec(selector); m; m = values.exec(selector)) {
        if (m[1] !== 'id' && LONG_NUMBER_RE.test(m[2] ?? '')) return true
    }
    return false
}

/** Whether `selector` is inside the learned coupon box grammar above and
 * holds nothing that looks like personal data. */
export function isLearnedBoxSelector(selector: string): boolean {
    return compoundsOf(selector) !== null && !holdsPersonalData(selector)
}

// Words that name a control that spends money or changes the cart, never one
// that applies a code. Matched as whole words of the lower-cased name, split
// on anything not a letter or digit: `place-order` and `place_order` are the
// pair `place order`, `placeOrder` is the word `placeorder`. Never inside a
// word: `display`, `buyer` and `PayPal` are not `pay` or `buy`.
const RISKY_CONTROL_WORDS: ReadonlySet<string> = new Set([
    'checkout',
    'pay',
    'buy',
    'purchase',
    'delete',
    'remove',
    'paynow',
    'buynow',
    'placeorder',
    'submitorder',
])
const RISKY_CONTROL_PAIRS: ReadonlySet<string> = new Set([
    'check out',
    'place order',
    'submit order',
    'pay now',
    'buy now',
])
// Carts often put the coupon apply in the checkout's own namespace
// (`#checkout-coupon-apply`, `button[name="checkout_reduction_code_apply"]`),
// so `checkout` alone (or `check out`) is not risky when the same compound
// also names one of these. Every other risky word stays absolute:
// `#checkout-coupon-remove` is still refused.
const CHECKOUT_RISKY: ReadonlySet<string> = new Set(['checkout', 'check out'])
const COUPON_WORDS: ReadonlySet<string> = new Set([
    'coupon',
    'coupons',
    'discount',
    'discounts',
    'promo',
    'promos',
    'reduction',
    'voucher',
    'vouchers',
    'code',
    'codes',
])

/**
 * Whether an APPLY or TOGGLE selector names a control that could place an
 * order, pay, or delete something (RISKY_CONTROL_WORDS). The extension clicks
 * these selectors, so the server refuses them outright.
 *
 * Only the LAST compound is read, the element that is clicked: its type, id,
 * classes and attribute VALUES. Ancestors are not (WooCommerce's own apply
 * button is `form.checkout_coupon button[name=apply_coupon]`), nor attribute
 * names (`button[data-buy-box]` says what data the element carries), nor what
 * `:not(...)` excludes. `checkout` alone does not make it risky when that
 * compound also names a coupon word (COUPON_WORDS). This is defence in depth and can be bypassed: a
 * substring or position selector (`[aria-label*=heckout]`,
 * `[id^=check][id$=out]`, `.cart__footer button[type=submit]`) names no risky
 * word, and neither does a joined camelCase word like `checkoutButton`. The
 * extension's own apply-control check on the page is what actually stops a
 * wrong click. The coupon field itself is not checked (typing into it clicks
 * nothing).
 */
export function isRiskyControlSelector(selector: string): boolean {
    const compounds = compoundsOf(selector)
    const clicked = compounds
        ? (compounds[compounds.length - 1] ?? '')
        : selector
    const words = clicked
        .replace(/:not\([^)]*\)/g, ' ')
        .replace(/\[[a-z0-9-]+/gi, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    const namesCoupon = words.some(word => COUPON_WORDS.has(word))
    return words.some((word, i) => {
        const pair = `${word} ${words[i + 1] ?? ''}`
        const risky = RISKY_CONTROL_WORDS.has(word)
            ? word
            : RISKY_CONTROL_PAIRS.has(pair)
              ? pair
              : null
        return risky !== null && !(namesCoupon && CHECKOUT_RISKY.has(risky))
    })
}
