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
// becomes [email]; then every word not on a fixed allowlist is dropped (see
// ALLOWED_WORDS). The [n] index is the one number kept: the answer names
// elements by it, and `elements[n]` maps it back to the node. A field's typed
// value is never read: of the inputs only a submit, button or reset button is
// named by its value, which is the label the store wrote on it.
//
// This file is not part of the content-script bundle. It ships beside it
// (assets/coupon-box-outline.js) and coupon-box-discovery.js imports it only
// when it is about to ask the server, so pages that never ask never load it.
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
// "Digit" is any Unicode number (\p{N}), not just 0-9: a phone number written
// in Arabic-Indic, Persian, fullwidth or circled digits has no letters, so the
// word allowlist below would otherwise keep it verbatim.
const scrub = s =>
    s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\p{N}/gu, '#')
const bytes = s => new TextEncoder().encode(s).length

// The words a name may carry. Every other word is dropped before the outline
// is built, so anything that is not a word stores put on their own controls
// (a person's name, a street, a city, a product, a message typed into a field)
// can never leave the browser, whatever element it turns up in: a saved
// address, a greeting, an aria-label, a value. A deny-list cannot promise
// that, because the words to deny are the shopper's and cannot be listed.
// The list is the one the server's pick was measured with: interface and
// coupon vocabulary in the store languages the finder reads. It changes only
// together with the server's eval.
// 2026-10-17: point(s), member(s), military, student(s), teacher(s), verify
// and verification. Shopping words, never the shopper's, so the pick can tell
// a points, member or student discount from a promo code box.
// Exported for the tests.
export const ALLOWED_WORDS = new Set(
    `
    a about accent accept accessibility accessories account achat act
    actiecode active add address affiliate affiliates affirm agree air
    aktionscode all allow also always american an and anwenden apartment
    aplicar app applica applied appliquer apply are arrivals art as at
    available avez back bag bags balance bar basket bath bathroom be become
    bed bedding bedroom beds bedside benefits best bestsellers billing blog
    body bon book bookcases books boots box brand brands bundles buono
    business buy by cadeau cadeaubon can cancel candles canjear canvas card
    cards care careers cart categories center certificate certificates chair
    chairs chance change chat check checkbox checkout chest choices choose
    christmas chrome city classic clean cleaning clear clearance click close
    clothing club code codes codice coffee collection collections com
    commercial company compare conditions confirm consent console consumer
    contact content continue control cookie cookies corporate cost country
    coupon coupons create credit cupom cupones cupón curated current
    cushions custom customer código data day deal deals decor decrease
    delete delivery desconto descuento design desk desks details dialog
    digital diners dining discount discounts discover do double drawers du
    easy edge edit eingeben einlösen elo email empty enjoy enter essential
    essentials etc event every exchanges exclusive expand explore express
    fabric face facebook fall faq faqs favorites featured feedback filter
    finalize financing find finder first fit floor footer footwear for
    frames free frequently fresh friend from full functional furniture
    gavekort get gift giftcard giftcards gifts gloves go golf got guarantee
    guide gutschein gutscheincode hand hast have health help here hide high
    history holiday home homepage how i ideal if ihr image in increase info
    information inserisci instagram invoeren is it item items jackets jcb
    join kampanjkod keep kids kitchen klarna know kod korting kortingscode
    label language last later learn leather left legal less light lighting
    like links list live living log login logo low loyalty made main manage
    map mattresses me media member members membership men menu message method military mini mirrors
    mobile modal modern more move my name navigate navigation necessary need
    new news next night no not notice notifications now number nursery of
    off offer offers office ok on one onetrust online only open opens
    optional options or order orders original our out outdoor outlet over
    pack page pants password pay payment paypal performance personal phone
    photo pillows pinterest place play plus point points policies policy postal power
    powered pre preference preferences presentkort press previous price
    privacy pro problem proceed product products program promo promos
    promotion promotional promotions protection province purchase qty
    qualify quantity questions quick rabatkode rabatowy rabatt rabattcode
    rabattkod receive redeem redemption refer refresh refund refunds region
    register remember remise remove report required resgatar resources
    retail return returns review reviews reward rewards right rights room
    rugs réduction safety saisir sale sales save sconto scroll search season
    seater secure security see select sell sellers service services set sets
    settings share ship shipping shoes shop shopping shorts show side
    sideboards sign site sitemap size skip sleep slide small social sofas
    space special start state statement status stools storage store stores
    story street strictly student students style submenu submit subscribe subtotal suite
    summary summarytotal supplies support sustainability tab table tables
    targeting tax teacher teachers team terms text that the there this tienes tiktok time
    tips to toepassen toggle tools top tops total track tracking trade
    traditional training travel trending tu twitter type un una under une
    unionpay up update updates use used value verification verify view votre voucher vouchers
    vous wall warranty was water we website what window wishlist with women
    world wrap you your youtube zip zniżka
`
        .split(/\s+/)
        .filter(Boolean),
)

/* `name` with only its allowlisted words: a whitespace-separated token is
 * kept verbatim when every run of letters in it is an allowed word (lowercased),
 * or when it has no letters at all ("#", "/", "*"); any other token is dropped.
 * '' when nothing is left. */
// Exported for the tests.
export function caramelAllowedWords(name) {
    return name
        .split(/\s+/)
        .filter(token => {
            const letters = token
                .toLowerCase()
                .replace(/[^\p{L}]+/gu, ' ')
                .trim()
            return (
                !letters || letters.split(' ').every(w => ALLOWED_WORDS.has(w))
            )
        })
        .join(' ')
        .trim()
}
// What a line may print as a name: scrubbed, then allowlisted.
const safeName = s => caramelAllowedWords(scrub(s))

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
        // An input's value is a label only on a button the store drew; on any
        // other input, whatever its role, it is what the shopper typed.
        if (el.tagName === 'INPUT')
            return norm(
                (/^(submit|button|reset)$/.test(el.type) ? el.value : '') ||
                    el.getAttribute('title'),
            )
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
                const name = safeName(clip(nameOf(n, role), 80))
                const state = []
                if (n.disabled || n.getAttribute('aria-disabled') === 'true')
                    state.push('disabled')
                const exp = n.getAttribute('aria-expanded')
                if (exp) state.push(exp === 'true' ? 'expanded' : 'collapsed')
                const body =
                    role +
                    (name ? ' "' + name + '"' : '') +
                    (state.length ? ' [' + state.join(', ') + ']' : '')
                push(depth, '[' + counter + '] ' + body, n, counter++)
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
                const name = safeName(clip(nameOf(n, role), 100))
                push(depth, 'heading' + (name ? ' "' + name + '"' : ''))
                continue
            }
            if (CONTAINER.test(role)) {
                const lb = n.getAttribute('aria-labelledby')
                const name = safeName(
                    clip(
                        norm(n.getAttribute('aria-label')) ||
                            (lb ? byIds(lb) : ''),
                        60,
                    ),
                )
                push(depth, role + (name ? ' "' + name + '"' : '') + ':')
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
