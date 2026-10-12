// owns: the page outline the coupon-box pick reads (caramelPageOutline).
//
// When the finder's rules see no promo box (coupon-box-discovery.js), the
// extension can ask the server which element is the box
// (POST /api/extension/coupon-box-pick). It does not send the page. It sends
// this outline: one line per interactive element, heading and landmark, in
// reading order, accessibility-tree style:
//
//   - form:
//     - [7] textbox "Discount Code (Optional)"
//     - [8] button "Apply"
//
// What it never carries: free page text (product names, prices, the shopper's
// own name and address on a checkout). Only an element's accessible name, and
// in every name each digit becomes # and anything shaped like an email address
// becomes [email]. The [n] index is the one number kept: the answer names
// elements by it, and `elements[n]` maps it back to the node.
//
// The format is the one the pick was measured on (roles, quoting, indentation,
// the [disabled] / [expanded] / [collapsed] states). Changing it changes what
// the model reads, so it changes only together with the server's eval.
//
// Plain DOM reads only, nothing clicked or changed.

// The server's cap on the outline, in UTF-8 bytes.
export const CARAMEL_OUTLINE_MAX_BYTES = 40 * 1024

const SKIP =
    /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|IMG|PICTURE|VIDEO|AUDIO|CANVAS|IFRAME|META|LINK|BR|HR)$/
const INPUT_ROLE = {
    search: 'searchbox',
    checkbox: 'checkbox',
    radio: 'radio',
    number: 'spinbutton',
    submit: 'button',
    button: 'button',
    reset: 'button',
    image: 'button',
}
const NO_INPUT =
    /^(hidden|file|color|range|date|datetime-local|month|week|time)$/
const TAG_ROLE = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    SUMMARY: 'button',
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    ASIDE: 'complementary',
    DIALOG: 'dialog',
    FORM: 'form',
    TABLE: 'table',
    TR: 'row',
    TD: 'cell',
    TH: 'cell',
    UL: 'list',
    OL: 'list',
    LI: 'listitem',
    DETAILS: 'group',
    FIELDSET: 'group',
    SECTION: 'region',
}
const INTERACTIVE =
    /^(textbox|searchbox|combobox|spinbutton|checkbox|radio|switch|button|link|tab|menuitem|option)$/
const FIELD = /^(textbox|searchbox|combobox|spinbutton|checkbox|radio|switch)$/
const CONTAINER =
    /^(navigation|main|banner|contentinfo|complementary|dialog|alertdialog|form|table|row|list|group|region|tabpanel|tablist|menu|listbox)$/

const norm = s =>
    String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
// Every digit and anything email-shaped, in everything but the [n] index.
const scrub = s =>
    s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\d/g, '#')
const bytes = s => new TextEncoder().encode(s).length

/* The outline of `root` (the page body by default) and the element each index
 * names: { outline, elements }, `elements[n]` being the node printed as [n].
 * Never over CARAMEL_OUTLINE_MAX_BYTES: past it, whole lines are dropped from
 * the end (never cut mid-line), and their indexes with them. */
// Called from coupon-box-discovery.js.
export function caramelPageOutline(root = document.body) {
    const doc = root.ownerDocument
    const win = doc.defaultView
    const lines = [] // { text, el, n } — el and n only on an indexed line
    let size = 0
    let counter = 0

    const hidden = el => {
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
        const cs = win?.getComputedStyle ? win.getComputedStyle(el) : null
        return !!cs && (cs.display === 'none' || cs.visibility === 'hidden')
    }
    const roleOf = el => {
        const r = (el.getAttribute('role') || '').split(/\s+/)[0]
        if (r && r !== 'presentation' && r !== 'none') return r
        if (el.tagName === 'INPUT') {
            const t = (el.getAttribute('type') || 'text').toLowerCase()
            if (NO_INPUT.test(t)) return ''
            return INPUT_ROLE[t] || 'textbox'
        }
        if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : ''
        if (/^H[1-6]$/.test(el.tagName)) return 'heading'
        if (el.tagName === 'SECTION')
            return el.hasAttribute('aria-label') ||
                el.hasAttribute('aria-labelledby')
                ? 'region'
                : ''
        return TAG_ROLE[el.tagName] || ''
    }
    const textOf = el =>
        norm(
            el.innerText != null && el.innerText !== ''
                ? el.innerText
                : el.textContent,
        )
    const byIds = ids =>
        norm(
            ids
                .split(/\s+/)
                .map(id => {
                    const n = doc.getElementById(id)
                    return n ? textOf(n) : ''
                })
                .join(' '),
        )
    // The first <label for> naming this id, in document order. Read without a
    // selector, so an id holding quotes or newlines needs no escaping.
    const labelFor = id => {
        for (const l of doc.querySelectorAll('label[for]'))
            if (l.htmlFor === id) return l
        return null
    }
    const nameOf = (el, role) => {
        const lb = el.getAttribute('aria-labelledby')
        if (lb) {
            const t = byIds(lb)
            if (t) return t
        }
        const al = norm(el.getAttribute('aria-label'))
        if (al) return al
        if (FIELD.test(role)) {
            if (el.id) {
                const l = labelFor(el.id)
                if (l) {
                    const t = textOf(l)
                    if (t) return t
                }
            }
            const wrap = el.closest('label')
            if (wrap) {
                const t = textOf(wrap)
                if (t) return t
            }
            const ph = norm(el.getAttribute('placeholder'))
            if (ph) return ph
            return norm(el.getAttribute('title'))
        }
        if (el.tagName === 'INPUT')
            return norm(el.value || el.getAttribute('title'))
        const t = textOf(el)
        if (t) return t
        const img = el.querySelector && el.querySelector('img[alt]')
        return norm(
            (img && img.getAttribute('alt')) || el.getAttribute('title'),
        )
    }
    // Past the cap nothing more is read: those lines would be dropped anyway.
    const push = (depth, text, el = null, n = -1) => {
        const line = '  '.repeat(depth) + '- ' + text
        lines.push({ text: line, el, n })
        size += bytes(line) + 1
    }
    const walk = (el, depth) => {
        for (const n of el.childNodes) {
            if (size > CARAMEL_OUTLINE_MAX_BYTES) return
            if (n.nodeType !== 1 || SKIP.test(n.tagName.toUpperCase())) continue
            if (hidden(n)) continue
            const role = roleOf(n)
            if (INTERACTIVE.test(role)) {
                const name = clip(nameOf(n, role), 80)
                const state = []
                if (n.disabled || n.getAttribute('aria-disabled') === 'true')
                    state.push('disabled')
                const exp = n.getAttribute('aria-expanded')
                if (exp) state.push(exp === 'true' ? 'expanded' : 'collapsed')
                const body =
                    role +
                    (name ? ' "' + name + '"' : '') +
                    (state.length ? ' [' + state.join(', ') + ']' : '')
                push(depth, '[' + counter + '] ' + scrub(body), n, counter++)
                if (FIELD.test(role)) continue
                if (
                    n.querySelector(
                        'input, textarea, select, button, a[href], [role]',
                    )
                )
                    walk(n, depth + 1)
                continue
            }
            if (role === 'heading') {
                push(
                    depth,
                    scrub('heading "' + clip(nameOf(n, role), 100) + '"'),
                )
                continue
            }
            if (CONTAINER.test(role)) {
                const lb = n.getAttribute('aria-labelledby')
                const name = clip(
                    norm(n.getAttribute('aria-label')) || (lb ? byIds(lb) : ''),
                    60,
                )
                push(depth, scrub(role + (name ? ' "' + name + '"' : '') + ':'))
                walk(n, depth + 1)
                continue
            }
            walk(n, depth)
        }
    }
    walk(root, 0)

    // Whole lines off the end until it fits (each line costs its bytes plus
    // the newline joining it to the next).
    while (lines.length && size - 1 > CARAMEL_OUTLINE_MAX_BYTES)
        size -= bytes(lines.pop().text) + 1
    const elements = []
    for (const l of lines) if (l.el) elements[l.n] = l.el
    return { outline: lines.map(l => l.text).join('\n'), elements }
}
