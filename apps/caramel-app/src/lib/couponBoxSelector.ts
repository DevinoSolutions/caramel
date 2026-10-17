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
// And nothing that looks like data about a person, anywhere in it (an
// attribute value, an id, a class): no `@` (or `%40`), which is how an email
// address would appear, and no run of 6 or more digits, which is how a phone,
// card, order or account number would. A store's markup can carry such data
// (`[data-customer-email="..."]`), and the privacy policy promises a box
// location never holds anything about the shopper. A real coupon box is found
// without them; a selector that needs them is refused whole.

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
const PERSONAL_DATA_RE = /@|%40|[0-9]{6}/i

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

/** Whether `selector` is inside the learned coupon box grammar above. */
export function isLearnedBoxSelector(selector: string): boolean {
    if (selector.length === 0 || selector.length > MAX_CHARS) return false
    if (FORBIDDEN_RE.test(selector)) return false
    if (PERSONAL_DATA_RE.test(selector)) return false
    const c: Cursor = { s: selector, i: 0, attributes: 0 }
    let compounds = 0
    for (;;) {
        if (!compound(c)) return false
        compounds += 1
        if (compounds > MAX_COMPOUNDS) return false
        if (c.attributes > MAX_ATTRIBUTES) return false
        if (c.i === c.s.length) return true
        const spaces = take(c, /^ +/)
        const combinator = take(c, /^[>+~] */)
        if (!spaces && !combinator) return false
        if (c.i === c.s.length) return false
    }
}

// Words that name a control that spends money or changes the cart, never one
// that applies a code. Matched with the separators taken out, so
// `place-order`, `place_order` and `placeOrder` are all `placeorder`.
const RISKY_CONTROL_JOINED_RE =
    /checkout|placeorder|submitorder|paynow|buynow|purchase|delete|remove/
// Matched as whole words only: `pay` must not refuse `display`.
const RISKY_CONTROL_WORDS = new Set(['pay', 'buy'])

/**
 * Whether an APPLY or TOGGLE selector names a control that could place an
 * order, pay, or delete something: checkout, place order, submit order, pay,
 * buy, purchase, delete, remove. The extension clicks these selectors, so the
 * server refuses them outright. This is defence in depth: the extension's own
 * apply-control check on the page is what actually stops a wrong click. The
 * coupon field itself is not checked (typing into it clicks nothing).
 */
export function isRiskyControlSelector(selector: string): boolean {
    const words = selector
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
    if (words.some(w => RISKY_CONTROL_WORDS.has(w))) return true
    return RISKY_CONTROL_JOINED_RE.test(words.join(''))
}
