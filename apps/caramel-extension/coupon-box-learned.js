// owns: the names a confirmed coupon box is saved under, and the per-install
// memory of those boxes (caramelBoxSelectors, caramelLearnedOutcome).
//
// A store with no config, where the finder found a box and the store ANSWERED
// a code typed into it (the total dropped, or the store replied about the
// code), has that box remembered: on the next visit it is tried first
// (coupon-box-discovery.js learnedRecord), through every check a fresh pick
// goes through. This module is not in the content-script bundle: the build
// ships it as assets/coupon-box-learned.js (wxt.config.ts) and the finder
// imports it only on a store with no config, when it is about to remember
// something. No imports of its own, so the shipped file is the measured one.
// The memory itself is read and written only by the background
// (caramelLearnedRead, caramelLearnedOutcome), for the host of the tab that
// asks: a page cannot name another store, nor write the memory at all.
//
// What is saved is CSS selectors, the form store configs use, built from what
// a store's markup calls the element: an id that is not generated, its name,
// aria-label, placeholder or test id, else a short path from the nearest
// element that has one. Never page text the shopper typed, a code, or a price.

// The memory: domain -> { v, input, apply, toggle, enterOnly, source,
// confirmedAt, failures }, oldest use first (object key order is insertion
// order for these keys), at most MAX_DOMAINS of them.
export const LEARNED_KEY = 'caramel_learned_boxes'
export const MAX_DOMAINS = 200
// Two failed uses in a row and the box is forgotten: normal detection runs.
export const MAX_FAILURES = 2
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

const quote = v => '"' + v + '"'
const usable = v =>
    typeof v === 'string' &&
    v.trim() !== '' &&
    v.length <= 80 &&
    !v.includes('"') &&
    !REFUSED.test(v) &&
    !PRIVATE.test(v)

/* The only selectors a learned box is built from or read with, the same rule
 * on both sides: compound parts of a tag, #id, .class,
 * [id|name|type|aria-label|placeholder|data-*="plain value"],
 * :first-of-type and :nth-of-type(n) (n up to 99), joined by spaces or ">".
 * An attribute value is 1-100 characters with no quote, backslash, bracket,
 * brace, ";", "<" or control character. At most four parts, three attribute
 * tests and MAX_READ_SELECTOR characters. This is a subset of the grammar the
 * server accepts and serves, so nothing built here is refused there. Anything
 * else (:has(), any other pseudo-class, a wildcard, a sibling combinator, an
 * unquoted or escaped value) is refused before any query runs: a selector
 * served by the server, or read back from storage, is data, and an expensive
 * or odd one is never evaluated. */
// The longest selector the server serves.
export const MAX_READ_SELECTOR = 256
const TAG_RE = /[a-z][a-z0-9-]*/iy
const SIMPLE_RE =
    /#[A-Za-z_][\w-]*|\.-?[A-Za-z_][\w-]*|\[(?:id|name|type|aria-label|placeholder|data-[a-z0-9-]+)="[^"'\\[\]{};<\p{Cc}]{1,100}"\]|:first-of-type|:nth-of-type\([1-9]\d?\)/uy
const JOIN_RE = / *> *| +/y

// Exported for tests/coupon-box-learned.test.mjs.
export function caramelSelectorAllowed(css) {
    if (
        typeof css !== 'string' ||
        !css ||
        css.length > MAX_READ_SELECTOR ||
        REFUSED.test(css)
    )
        return false
    let at = 0
    let parts = 0
    let attrs = 0
    // The next token of `re` at `at`, consumed; '' when there is none.
    const take = re => {
        re.lastIndex = at
        const m = re.exec(css)?.[0] || ''
        at += m.length
        return m
    }
    for (;;) {
        let any = !!take(TAG_RE)
        for (let s; (s = take(SIMPLE_RE)); any = true) if (s[0] === '[') attrs++
        if (!any || ++parts > 4 || attrs > 3) return false
        if (at === css.length) return true
        if (!take(JOIN_RE) || at === css.length) return false
    }
}

/* The one element `css` finds in `doc`, or null: a selector outside the
 * grammar is never queried, and one that finds two elements (a gift-card
 * field beside the box) names neither. */
// Called from coupon-box-discovery.js.
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
// Exported for tests/coupon-box-learned.test.mjs.
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
// Exported for tests/coupon-box-learned.test.mjs.
export function caramelBoxSelectors(input, button, toggle) {
    const box = {
        input: caramelStableSelector(input),
        apply: button ? caramelStableSelector(button) : null,
        toggle: toggle ? caramelStableSelector(toggle) : null,
        enterOnly: !button,
    }
    if (!box.input || (button && !box.apply) || (toggle && !box.toggle))
        return null
    return box
}

/* What a run carries to remember its box: the domain, the box's selectors
 * (`box` already saved ones, or [input, button, toggle] elements to name),
 * where it came from, and whether it came from memory (this install's or the
 * server's): only such a box is reported as failed. null when the box has no
 * stable name. */
// Called from coupon-box-discovery.js.
export function caramelLearnable(domain, box, source, learned) {
    if (Array.isArray(box)) box = caramelBoxSelectors(...box)
    if (!box) return null
    return {
        domain,
        box: {
            input: box.input,
            apply: box.apply || null,
            toggle: box.toggle || null,
            enterOnly: !!box.enterOnly,
        },
        source,
        learned: !!learned,
    }
}

// What the memory accepts, whoever asks: a domain, a box whose every
// selector is in the grammar (caramelSelectorAllowed, so at most
// MAX_READ_SELECTOR characters each), a source the finder writes, and an
// outcome. Anything else is refused before storage is read: a value that
// reached here from a page never lands in the memory.
const SOURCES = ['rules', 'llm', 'server_learned']
const OUTCOMES = ['confirmed', 'failed']
const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/
const optional = css => css == null || caramelSelectorAllowed(css)
// Exported for tests/coupon-box-learned.test.mjs.
export const caramelLearnedValid = (domain, box, source, outcome) =>
    typeof domain === 'string' &&
    DOMAIN_RE.test(domain) &&
    !!box &&
    typeof box === 'object' &&
    caramelSelectorAllowed(box.input) &&
    optional(box.apply) &&
    optional(box.toggle) &&
    SOURCES.includes(source) &&
    OUTCOMES.includes(outcome)

/* The box saved for `domain` in `area` (storage.local), or null. Only an
 * entry the memory could have written is returned. */
// Called from background.js.
export async function caramelLearnedRead(area, domain) {
    const b = (await read(area))[domain]
    return b?.v === 1 && caramelLearnedValid(domain, b, b.source, 'confirmed')
        ? b
        : null
}

const same = (a, b) =>
    !!a &&
    a.input === b.input &&
    (a.apply || null) === (b.apply || null) &&
    (a.toggle || null) === (b.toggle || null) &&
    !!a.enterOnly === !!b.enterOnly

const read = area =>
    new Promise((resolve, reject) => {
        area.get([LEARNED_KEY], items => {
            const err = globalThis.chrome?.runtime?.lastError
            if (err) reject(new Error(err.message || String(err)))
            else resolve(items?.[LEARNED_KEY] || {})
        })
    })
const write = (area, map) =>
    new Promise((resolve, reject) => {
        area.set({ [LEARNED_KEY]: map }, () => {
            const err = globalThis.chrome?.runtime?.lastError
            if (err) reject(new Error(err.message || String(err)))
            else resolve()
        })
    })

/* Record what one use of a box taught us, in `area` (storage.local).
 *   confirmed: the box is saved (or refreshed) for `domain` with no failures,
 *              and becomes the most recently used;
 *   failed:    if it is the box saved for `domain`, one more failure, and on
 *              the second it is forgotten. A failure of some other box says
 *              nothing about the saved one, which is left as it was.
 * Past MAX_DOMAINS, the least recently used domains are forgotten.
 * Returns what happened: 'saved' | 'failed' | 'dropped' | 'kept', or
 * 'refused' for anything caramelLearnedValid does not accept. Throws when
 * storage refuses, so the caller can say so. The background is the one
 * writer, one write at a time (background.js saveLearned). */
// Called from background.js.
export async function caramelLearnedOutcome(
    area,
    domain,
    box,
    source,
    outcome,
    now,
) {
    if (!caramelLearnedValid(domain, box, source, outcome)) return 'refused'
    const map = await read(area)
    const was = map[domain]
    let result = 'kept'
    if (outcome === 'confirmed') {
        delete map[domain]
        map[domain] = {
            v: 1,
            input: box.input,
            apply: box.apply || null,
            toggle: box.toggle || null,
            enterOnly: !!box.enterOnly,
            source,
            confirmedAt: now,
            failures: 0,
        }
        result = 'saved'
    } else if (same(was, box)) {
        const failures = (Number(was.failures) || 0) + 1
        delete map[domain]
        if (failures < MAX_FAILURES) {
            map[domain] = { ...was, failures }
            result = 'failed'
        } else result = 'dropped'
    } else return result
    const keys = Object.keys(map)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DOMAINS)))
        delete map[k]
    await write(area, map)
    return result
}
