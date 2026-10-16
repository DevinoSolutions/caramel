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
