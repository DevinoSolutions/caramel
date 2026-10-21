// owns: the stable CSS selectors a coupon box the finder found is named by
// (caramelStableSelector, caramelBoxSelectors), and the small selector
// grammar they are built in and read with (caramelSelectorAllowed,
// caramelOne, caramelRiskyControl).
//
// A store with no config, where the finder found a box and a code typed into
// it lowered the total, has that box saved as the store's config
// (coupon-box-discovery.js savable; background.js couponBoxSave). This
// module names the box for that save. It is not in the content-script
// bundle: the build ships it as assets/coupon-box-selectors.js
// (wxt.config.ts) and the finder imports it only on a store with no config,
// once it has a box. No imports of its own, so the shipped file is the
// measured one. The background reads the same rules before it sends a save.
//
// What is named is CSS selectors, the form store configs use, built from what
// a store's markup calls the element: an id that is not generated, its name,
// aria-label, placeholder or test id, else a short path from the nearest
// element that has one. Never page text the shopper typed, a code, or a price.

// The server refuses a longer selector; one this long is no stable name.
export const MAX_SELECTOR = 200

// An id or test id a framework generates is new on every render: React
// ':r1:', 'mui-12', 'ember123', 'react-select-2-input', a hex or long digit
// run. It names nothing that will be there next time.
const GENERATED =
    /:|^(?:mui|ember|radix|headlessui|react-select|react|rc|chakra|downshift|field|input|select|el|id|uid)[-_]?\d|(?=[0-9a-f]*\d)[0-9a-f]{8,}|\d{4,}/i
// A value that could be the shopper's or the cart's (an email, a number, a
// price) is never part of a saved name.
const PRIVATE = /@|\d{3,}|[$£€¥₹]/
const TEST_IDS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'data-automation-id',
]
const PLAIN_ID = /^[A-Za-z][\w-]*$/
// What the server refuses in a selector (it is stored and served to other
// installs as CSS): anything that reads as XPath, script or a style
// expression, the characters { } ; < \ and control characters. A name that
// would need one of these, or a quote (escaping it takes a backslash), is no
// name; a selector holding one is never built.
const REFUSED = /^[./(]|javascript:|url\s*\(|expression|[{};<\\]|\p{Cc}/iu
// Nothing that looks like data about a person: no `@` (or `%40`) anywhere,
// which is how an email address would appear, and in an attribute value
// other than `id` no number of 6 or more digits, even split by spaces, dashes
// or dots, which is how a phone, card, order or account number would. Ids and
// classes may hold long numbers: stores generate them, and they name an
// element rather than carry a value. The server refuses such a selector whole
// (couponBoxSelector.ts holdsPersonalData); the patterns are its own.
const EMAIL_SIGN = /@|%40/i
// 6 or more digits, which a page may group with spaces, dashes or dots.
const LONG_NUMBER = /[0-9](?:[ .-]*[0-9]){5,}/
// An attribute selector with a value, once the grammar has accepted it.
const ATTR_VALUE = /\[([a-z0-9-]+)[$^*]?=("[^"]*"|[A-Za-z0-9_-]+)\]/g
function holdsPersonalData(css) {
    if (EMAIL_SIGN.test(css)) return true
    for (const m of css.matchAll(ATTR_VALUE))
        if (m[1] !== 'id' && LONG_NUMBER.test(m[2])) return true
    return false
}

const quote = v => '"' + v + '"'
const usable = v =>
    typeof v === 'string' &&
    v.trim() !== '' &&
    v.length <= 80 &&
    !v.includes('"') &&
    !REFUSED.test(v) &&
    !PRIVATE.test(v)

/* The only selectors a saved box is built from or read with, the same rule
 * on both sides: compound parts of a tag, #id, .class,
 * [id|name|type|aria-label|placeholder|data-*="plain value"],
 * :first-of-type and :nth-of-type(n) (n up to 99), joined by spaces or ">".
 * An attribute value is 1-100 characters with no quote, backslash, bracket,
 * brace, ";", "<" or control character. At most four parts, three attribute
 * tests and MAX_READ_SELECTOR characters, and nothing that looks like personal
 * data (holdsPersonalData). This is a subset of the grammar the server accepts and
 * serves, so nothing built here is refused there. Anything
 * else (:has(), any other pseudo-class, a wildcard, a sibling combinator, an
 * unquoted or escaped value) is refused before any query runs: a selector
 * served by the server is data, and an expensive or odd one is never
 * evaluated. */
// The longest selector the server serves.
export const MAX_READ_SELECTOR = 256
const TAG_RE = /[a-z][a-z0-9-]*/iy
const SIMPLE_RE =
    /#[A-Za-z_][\w-]*|\.-?[A-Za-z_][\w-]*|\[(?:id|name|type|aria-label|placeholder|data-[a-z0-9-]+)="[^"'\\[\]{};<\p{Cc}]{1,100}"\]|:first-of-type|:nth-of-type\([1-9]\d?\)/uy
const JOIN_RE = / *> *| +/y

// The selector's parts in order (`form.a > button#b` -> `form.a`,
// `button#b`), or null when it is outside the grammar above.
function partsOf(css) {
    if (
        typeof css !== 'string' ||
        !css ||
        css.length > MAX_READ_SELECTOR ||
        REFUSED.test(css)
    )
        return null
    let at = 0
    let attrs = 0
    const parts = []
    // The next token of `re` at `at`, consumed; '' when there is none.
    const take = re => {
        re.lastIndex = at
        const m = re.exec(css)?.[0] || ''
        at += m.length
        return m
    }
    for (;;) {
        const start = at
        let any = !!take(TAG_RE)
        for (let s; (s = take(SIMPLE_RE)); any = true) if (s[0] === '[') attrs++
        if (!any || attrs > 3) return null
        parts.push(css.slice(start, at))
        if (parts.length > 4) return null
        if (at === css.length) return parts
        if (!take(JOIN_RE) || at === css.length) return null
    }
}

// Exported for tests/coupon-box-selectors.test.mjs.
export function caramelSelectorAllowed(css) {
    return partsOf(css) !== null && !holdsPersonalData(css)
}

/* The one element `css` finds in `doc`, or null: a selector outside the
 * grammar is never queried, and one that finds two elements (a gift-card
 * field beside the box) names neither. */
// Exported for tests/coupon-box-selectors.test.mjs.
export function caramelOne(doc, css) {
    if (!caramelSelectorAllowed(css)) return null
    try {
        const m = doc.querySelectorAll(css)
        return m.length === 1 ? m[0] : null
    } catch {
        return null
    }
}

// The selector, when it finds exactly `el` in its document and nothing else.
const only = (el, css) =>
    css &&
    css.length <= MAX_SELECTOR &&
    caramelOne(el.ownerDocument, css) === el
        ? css
        : null

// The element's own stable names, best first, each as a selector that may or
// may not be unique yet.
function ownNames(el) {
    const tag = el.tagName.toLowerCase()
    const out = []
    const id = el.getAttribute('id')
    if (usable(id) && !GENERATED.test(id))
        out.push(PLAIN_ID.test(id) ? tag + '#' + id : `${tag}[id=${quote(id)}]`)
    for (const a of ['name', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a)
        if (usable(v)) out.push(`${tag}[${a}=${quote(v)}]`)
    }
    for (const a of TEST_IDS) {
        const v = el.getAttribute(a)
        if (usable(v) && !GENERATED.test(v))
            out.push(`${tag}[${a}=${quote(v)}]`)
    }
    return out
}

// A stable selector for `el`, or null. Its own name first; then a short path
// (at most three steps, so four parts with the anchor) down from the nearest
// ancestor that has a unique name of its own. Every answer is checked: it is
// in the grammar and finds exactly this element.
// Exported for tests/coupon-box-selectors.test.mjs.
export function caramelStableSelector(el) {
    if (!el || el.nodeType !== 1) return null
    for (const css of ownNames(el)) if (only(el, css)) return css
    const steps = []
    let node = el
    for (let i = 0; i < 3 && node.parentElement; i++) {
        const parent = node.parentElement
        const tag = node.tagName.toLowerCase()
        const same = [...parent.children].filter(
            c => c.tagName === node.tagName,
        )
        steps.unshift(
            same.length > 1
                ? `${tag}:nth-of-type(${same.indexOf(node) + 1})`
                : tag,
        )
        if (parent === el.ownerDocument.body) break
        for (const anchor of ownNames(parent)) {
            if (!only(parent, anchor)) continue
            const css = only(el, anchor + ' > ' + steps.join(' > '))
            if (css) return css
        }
        node = parent
    }
    return null
}

// The selectors for one box: its input, its apply button (null when the box
// applies on Enter) and the toggle that opened it (null when it was showing).
// null when any part of it has no stable name: half a box is not a box.
// Exported for tests/coupon-box-selectors.test.mjs.
export function caramelBoxSelectors(input, button, toggle) {
    const box = {
        input: caramelStableSelector(input),
        apply: button ? caramelStableSelector(button) : null,
        toggle: toggle ? caramelStableSelector(toggle) : null,
    }
    if (!box.input || (button && !box.apply) || (toggle && !box.toggle))
        return null
    return box
}

// Words that name a control that spends money or changes the cart, never one
// that applies a code. Matched as whole words of the lower-cased name, split
// on anything not a letter or digit: `place-order` and `place_order` are the
// pair `place order`, `placeOrder` is the word `placeorder`. Never inside a
// word: `display`, `buyer` and `PayPal` are not `pay` or `buy`.
const RISKY_CONTROL_WORDS = new Set([
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
const RISKY_CONTROL_PAIRS = new Set([
    'check out',
    'place order',
    'submit order',
    'pay now',
    'buy now',
])
// Carts often put the coupon apply in the checkout's own namespace
// (`#checkout-coupon-apply`, `button[name="checkout_reduction_code_apply"]`),
// so `checkout` alone (or `check out`) is not risky when the same part also
// names one of these. Every other risky word stays absolute:
// `#checkout-coupon-remove` is still refused.
const CHECKOUT_RISKY = new Set(['checkout', 'check out'])
const COUPON_WORDS = new Set([
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

/* Whether an APPLY or TOGGLE selector names a control that could place an
 * order, pay, or delete something (RISKY_CONTROL_WORDS). The same rule the
 * server refuses a save with (couponBoxSelector.ts isRiskyControlSelector),
 * so such a box is never sent.
 *
 * Only the LAST part is read, the element that is clicked: its tag, id,
 * classes and attribute VALUES. Ancestors are not (WooCommerce's own apply
 * button sits in `form.checkout_coupon`), nor attribute names, which say what
 * data the element carries. `checkout` alone does not make it risky when that
 * part also names a coupon word (COUPON_WORDS). A selector outside the
 * grammar is read whole. The coupon field itself is not checked (typing into
 * it clicks nothing). */
// Exported for tests/coupon-box-selectors.test.mjs.
export function caramelRiskyControl(css) {
    const parts = partsOf(css)
    const words = (parts ? parts[parts.length - 1] : String(css))
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
