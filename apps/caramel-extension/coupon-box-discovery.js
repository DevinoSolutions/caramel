// owns: finding a store's promo box, apply button, reveal toggle and order
// total when no config describes them (caramelDiscoverCouponBox,
// caramelFindOrderTotal, caramelDiscoveredRecord, caramelFinderSeesBox,
// caramelCouponBoxDiscoveryOn).
//
// Most stores we hold codes for are reached through a config row: a set of
// selectors someone wrote for that store. Two cases have no usable row: a
// store nobody has written one for, and a store whose page changed under it.
// In both, the shopper used to be handed the codes to copy and paste.
//
// This module reads the page the way a shopper does: the field whose own name,
// label or heading says coupon/promo/discount/voucher (in the languages our
// stores ship in), the button beside it whose label says apply, and the row
// labelled total. Every pick carries the reasons it won, so a wrong pick can
// be explained instead of guessed at.
//
// It is SWITCHED OFF by default: the server's couponBoxDiscovery flag
// (GET /api/extension/features) turns it on. Off, nothing here runs.
//
// Two rules keep it from claiming what it cannot see:
//   · no total row, no discovery. A store found this way is judged by its
//     total alone (coupon-apply.js caramelAwaitCouponVerdict): the code worked
//     only if the total went down. Without a readable total there is nothing
//     honest to say, so the old copy-the-codes answer stands.
//   · one code per page load on a cart whose apply button reloads the page.
//     The picks are markers on the page, so they do not survive the reload:
//     the code we submitted is judged on the page the store sends back (by
//     the same total reader, caramelFinderReadTotal), and the run ends there
//     rather than guessing at a box on a page it has not read.
//   · only the page's own document. A box inside a shadow root or a frame is
//     out of reach, because the apply flow finds what we picked through a
//     document query (the data-caramel-found marker below).
import { caramelSendMessage, log, sleep } from './caramel-base.js'
import {
    _isVisible,
    caramelFindMoney,
    caramelIsForbiddenControl,
    getPrice,
} from './dom-utils.js'

/* ------------------------------------------------------------ vocabulary */
// Words a store uses for the coupon box. Scored on the input's own attributes
// and on its label.
const STRONG = [
    'coupon',
    'promo',
    'discount',
    'voucher',
    'reduction',
    'reductions',
    'rabatt',
    'gutschein',
    'descuento',
    'cupon',
    'cupón',
    'cupom',
    'desconto',
    'sconto',
    'korting',
    'kortingscode',
    'kupon',
    'kod rabatowy',
    'code promo',
    'code de réduction',
    'offer code',
    'redeem',
    'redemption',
    'promotion',
    'promotional',
    'rebate',
    'alennus',
    'rabattkod',
]
// Weak on their own: "code" is also a postcode, "gift" also a gift message.
const WEAK = ['code', 'gift card', 'giftcard', 'gift-card', 'certificate']
// Fields that are never the coupon box. Matched on attributes only: a label
// like "Gift card or discount code" must not be vetoed by "card".
const NEGATIVE = [
    'postcode',
    'postal',
    'zip',
    'address',
    'email',
    'e-mail',
    'phone',
    'tel',
    'search',
    'query',
    'card-number',
    'cardnumber',
    'cc-number',
    'cvv',
    'cvc',
    'security',
    'expir',
    'firstname',
    'first-name',
    'lastname',
    'last-name',
    'fullname',
    'city',
    'state',
    'country',
    'password',
    'qty',
    'quantity',
    'newsletter',
    'message',
    'note',
    'comment',
    'instructions',
    'pin',
    'username',
    'login',
    'company',
    'vat',
    'tax-id',
    'taxid',
    'birthday',
    'otp',
    'verification',
]
const APPLY_WORDS = [
    'apply',
    'redeem',
    'use code',
    'submit',
    'add',
    'ok',
    'go',
    'validate',
    'anwenden',
    'einlösen',
    'aplicar',
    'appliquer',
    'applica',
    'toepassen',
    'zastosuj',
    'använd',
    'käytä',
    'utiliser',
    'valider',
    'usar',
    'übernehmen',
    'activate',
    'use',
]
// The first three are the apply verbs proper: a label holding one of them may
// also hold a danger word ("Apply & continue") and still be the apply button.
const APPLY_VERBS = APPLY_WORDS.slice(0, 3)
// A button with one of these words places an order or leaves the cart. Never
// click it, whatever else it says.
const DANGER = [
    'pay',
    'place order',
    'checkout',
    'check out',
    'continue',
    'buy',
    'purchase',
    'complete',
    'confirm order',
    'order now',
    'subscribe',
    'sign up',
    'sign in',
    'log in',
    'login',
    'register',
    'proceed',
    'next',
    'payer',
    'bezahlen',
    'kaufen',
    'comprar',
    'pagar',
    'commander',
    'remove',
    'delete',
    'search',
    // Beside a promo box on a product-heavy cart: it changes the cart, never
    // applies a code.
    'add to cart',
    'add to bag',
    'add to basket',
    'wishlist',
    'warenkorb',
    'panier',
    'carrito',
    'carrello',
    'winkelwagen',
    'koszyk',
    'cesta',
]
// "gift" only as a code: card/certificate/voucher. "Add a free gift message"
// opens a message drawer, not a promo box.
const TOGGLE_RE =
    /(have|got|add|enter|apply|use|show|redeem|ajouter|saisir|einl[oö]sen|a[nñ]adir|tienes|inserisci|aggiungi)\b.{0,30}\b(promo|coupon|discount|voucher|gift[\s-]?(card|certificate|voucher|code)|code|gutschein|rabatt|cup[oó]n|c[oó]digo|codice)/i
// The noun FIRST, as German, Dutch and Italian say it ("Gutscheincode
// eingeben"). The whole label, so a sentence that merely mentions a voucher is
// not a toggle.
const TOGGLE_OBJ_RE =
    /^\s*(gutschein(code)?|rabatt(code)?|aktionscode|promo-?code|kortingscode|actiecode|codice (sconto|promozionale|promo)|buono sconto)\s*(eingeben|einl[oö]sen|hinzuf[üu]gen|invoeren|toevoegen|inserisci|aggiungi|inserire)\s*[+▾▼›>→]?\s*$/i
// A bare row title: "Coupon/Gift Certificate", "Promo code", "Coupon:".
const TOGGLE_BARE_RE =
    /^\s*(promo(tion(al)?)?|coupon|discount|voucher|gift card)\s*(code)?s?\s*((or|\/|&|and)\s*(gift\s+(card|certificate)|coupon|promo(\s+code)?)s?)?\s*[?:]?\s*[+▾▼›>]?\s*$/i
// The noun as a row title with the verb AFTER it ("Coupon  View →").
const TOGGLE_TAIL_RE =
    /^\s*(promo(tion(al)?)?|coupon|discount|voucher)\s*(code)?s?\s*(view|show|open|add|see|enter)( all| code| it)?\s*[+▾▼›>→]?\s*$/i

/* --------------------------------------------------------------- helpers */
const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim()
const textOf = el => (el ? el.innerText || el.textContent || '' : '')
const styleOf = el => el.ownerDocument.defaultView.getComputedStyle(el)
const pointer = el => styleOf(el).cursor === 'pointer'

// Rendered AND given a box. An ancestor collapsed to zero height hides us
// without a style of our own, so that is checked too.
function visible(el) {
    if (!el || !el.isConnected || !_isVisible(el)) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    let p = el.parentElement
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
        const ps = styleOf(p)
        if (ps.overflow === 'hidden' && p.getBoundingClientRect().height < 2)
            return false
    }
    return true
}

function labelText(el) {
    const parts = []
    for (const l of el.labels || []) parts.push(textOf(l))
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
        for (const id of lb.split(/\s+/)) {
            const t = el.ownerDocument.getElementById(id)
            if (t) parts.push(t.textContent)
        }
    }
    return norm(parts.join(' '))
}

// Short text near the input: the WIDEST ancestor text that is still short (the
// nearest one can be just the button row "Apply", with the heading one level
// up), plus the name of a labelled region around it (an accordion whose header
// sits outside the region it opens).
function contextText(el) {
    let best = ''
    let p = el.parentElement
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        const t = norm(textOf(p))
        if (t.length > 160) break
        if (t) best = t
    }
    let q = el.parentElement
    for (let i = 0; i < 8 && q; i++, q = q.parentElement) {
        const own = q.getAttribute('aria-label') || ''
        const ids = (q.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
        const named = norm(
            [
                own,
                ...ids.map(
                    id => q.ownerDocument.getElementById(id)?.textContent || '',
                ),
            ].join(' '),
        )
        if (named && named.length <= 60) {
            best = norm(best + ' ' + named)
            break
        }
    }
    return best
}

function attrText(el) {
    const parts = [
        el.id,
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('autocomplete'),
        el.getAttribute('title'),
        typeof el.className === 'string' ? el.className : '',
    ]
    for (const a of el.attributes)
        if (a.name.startsWith('data-')) parts.push(a.name + ' ' + a.value)
    return norm(parts.join(' '))
}

// Whole-word-ish match: "code" must hit "discount_code" but the word list's
// "first-name" must also meet "customer[first_name]", so _ - . [ ] ( ) / : are
// boundaries on BOTH sides.
const SEP = /[_\-.[\]()/:]+/g
function has(text, w) {
    const t = ' ' + text.replace(SEP, ' ') + ' '
    const v = w.replace(SEP, ' ')
    return (
        t.includes(' ' + v + ' ') ||
        t.includes(' ' + v + 's ') ||
        (w.length >= 5 && text.includes(w))
    )
}

/* ---------------------------------------------------------------- inputs */
// Judged by the PROPERTY, which is what the browser renders: an unknown type
// attribute (<input type="input">) is a text box, and an attribute selector
// never sees it.
function scoreInputs(doc) {
    const candidates = []
    const win = doc.defaultView
    const pageW = doc.documentElement.scrollWidth
    for (const el of doc.querySelectorAll('input')) {
        if (el.type !== 'text' && el.type !== 'search') continue
        if (el.readOnly) continue
        // A field parked far off-screen is a bot honeypot, not for people.
        const box = el.getBoundingClientRect()
        if (
            box.right + win.scrollX < -100 ||
            box.bottom + win.scrollY < -100 ||
            (pageW > 0 && box.left + win.scrollX > pageW + 100)
        )
            continue
        const attrs = attrText(el)
        const label = labelText(el)
        const ctx = contextText(el)
        const reasons = []
        let score = 0
        const strongAttr = STRONG.filter(w => has(attrs, w))
        const strongLabel = STRONG.filter(w => has(label, w))
        // Context is weaker evidence than the field's own words, and two
        // contexts lie: a newsletter blurb ("special offers, exclusive
        // promotions") and a gift-card widget ("Redeem" beside "Gift Card").
        const weak = WEAK.filter(w => has(attrs, w) || has(label, w))
        let strongCtx = STRONG.filter(w => has(ctx, w))
        if (/newsletter|subscribe|sign up for|signup|join our/.test(ctx))
            strongCtx = []
        const form = el.form || el.closest('form')
        // An account form ("perks and promotions by email" under a password
        // field) is never a coupon box on context alone.
        if (form?.querySelector('input[type=password]')) strongCtx = []
        if (
            weak.some(w => w.includes('gift')) &&
            !strongAttr.length &&
            !strongLabel.length
        )
            strongCtx = strongCtx.filter(w => !/^redeem|^redemption/.test(w))
        if (strongAttr.length) {
            score += 50 + 5 * (strongAttr.length - 1)
            reasons.push('attr:' + strongAttr.join('|'))
        }
        if (strongLabel.length) {
            score += 40
            reasons.push('label:' + strongLabel.join('|'))
        }
        if (strongCtx.length) {
            score += 20
            reasons.push('ctx:' + strongCtx.join('|'))
        }
        if (weak.length) {
            score += strongAttr.length || strongLabel.length ? 5 : 15
            reasons.push('weak:' + weak.join('|'))
        }
        const neg = NEGATIVE.filter(w => has(attrs, w))
        if (neg.length && !strongAttr.length) {
            score -= 80
            reasons.push('neg:' + neg.join('|'))
        } else if (neg.length) {
            score -= 15
            reasons.push('neg-soft:' + neg.join('|'))
        }
        // Site search lives in a search form or a role=search region.
        const action = norm(form?.getAttribute('action'))
        if (
            el.closest('[role="search"]') ||
            /search|\/s\b|query/.test(action)
        ) {
            score -= 100
            reasons.push('in-search')
        }
        if (/coupon|promo|discount|voucher|reduction/.test(action)) {
            score += 25
            reasons.push('form-action')
        }
        // A gift-card-only box takes a different kind of code.
        if (
            weak.some(w => w.includes('gift')) &&
            !strongAttr.length &&
            !strongLabel.length &&
            !strongCtx.length
        ) {
            score -= 20
            reasons.push('gift-only')
        }
        // A box disabled until the cart has items is still the box, but never
        // one we may type into, so it can only lose to a live one.
        if (el.disabled) {
            score -= 30
            reasons.push('disabled')
        }
        const vis = visible(el)
        if (vis) {
            score += 15
            reasons.push('visible')
        } else {
            score -= 10
            reasons.push('hidden')
        }
        const ml = Number(el.getAttribute('maxlength'))
        if (ml && ml < 4) {
            score -= 30
            reasons.push('maxlength<4')
        }
        // No coupon evidence, no candidate. A visible text field on a cart page
        // is a zip code or a newsletter box far more often than a coupon box,
        // and typing a code into one is worse than finding nothing.
        const evidence =
            strongAttr.length ||
            strongLabel.length ||
            strongCtx.length ||
            reasons.includes('form-action')
        if (score > 0 && evidence)
            candidates.push({ el, score, reasons, visible: vis })
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates
}

/* --------------------------------------------------------------- buttons */
const buttonLabel = el =>
    norm(
        el.innerText ||
            el.value ||
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.textContent,
    )
const isDanger = text => DANGER.some(w => has(text, w))
// Every kind of field a button could belong to: a submit/button input is a
// button, not a field.
const FIELDS =
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea'

function scoreButton(btn, input, level) {
    const reasons = []
    const text = buttonLabel(btn)
    const attrs = attrText(btn)
    let s = 0
    if (text.length > 40) return null
    // The coupon form's own way out never applies a code.
    if (
        /^(cancel|close|dismiss|back|no,? thanks|not now|remove|clear)$/i.test(
            text,
        )
    )
        return null
    if (isDanger(text) && !APPLY_VERBS.some(w => has(text, w))) return null
    const applyHit = APPLY_WORDS.filter(w => has(text, w) || has(attrs, w))
    if (applyHit.length) {
        s += 40
        reasons.push('apply:' + applyHit[0])
    }
    if (STRONG.some(w => has(attrs, w))) {
        s += 20
        reasons.push('attr-coupon')
    }
    const form = input.form || input.closest('form')
    if (form && (btn.form === form || form.contains(btn))) {
        const fields = form.querySelectorAll(
            'input:not([type=hidden]), select, textarea',
        ).length
        if (fields <= 2) {
            s += 25
            reasons.push('same-small-form')
        } else {
            s += 5
            reasons.push('same-form')
        }
        if ((btn.type || '').toLowerCase() === 'submit') {
            s += 10
            reasons.push('submit')
        }
    }
    s += Math.max(0, 25 - level * 5)
    reasons.push('level:' + level)
    // The apply button sits beside or under the box.
    const a = input.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    if (a.width && b.width) {
        const dx = Math.max(
            0,
            Math.max(a.left, b.left) - Math.min(a.right, b.right),
        )
        const dy = Math.max(
            0,
            Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom),
        )
        const d = Math.hypot(dx, dy)
        if (d < 40) {
            s += 15
            reasons.push('adjacent')
        } else if (d > 400) {
            s -= 20
            reasons.push('far')
        }
    }
    if (!applyHit.length && !text) {
        s -= 5
        reasons.push('icon-only')
    }
    // A control that SAYS something else ("Read More"), carries no coupon
    // attribute, is not beside the box and is not in its small form is not
    // its apply button.
    if (
        !applyHit.length &&
        text &&
        !reasons.includes('attr-coupon') &&
        !reasons.includes('adjacent') &&
        !reasons.includes('same-small-form')
    )
        return null
    // A box the shopper can see is applied by a button they can see.
    if (visible(input) && !visible(btn)) {
        s -= 30
        reasons.push('hidden')
    }
    // Two boxes, two "Apply" buttons (coupon and gift card side by side): a
    // button belongs to the field in the SMALLEST container holding both a
    // field and it. If that field is not ours, it applies the other box.
    for (
        let p = btn.parentElement, i = 0;
        p && i < 6;
        p = p.parentElement, i++
    ) {
        const fields = [...p.querySelectorAll(FIELDS)]
        if (!fields.length) continue
        if (!fields.includes(input)) {
            s -= 45
            reasons.push('other-field')
        }
        break
    }
    return { s, reasons }
}

// In-page anchors and role=button count: plenty of stores apply with
// <a href="javascript:void(0)">Apply</a>.
const BTN =
    'button, input[type="submit"], input[type="button"], [role="button"], a[href^="#"], a[href^="javascript:" i], a:not([href])'

function findButton(input) {
    const seen = new Set()
    let best = null
    const consider = (btn, level) => {
        if (seen.has(btn) || btn === input) return
        seen.add(btn)
        const r = scoreButton(btn, input, level)
        if (r && r.s > 20 && (!best || r.s > best.score))
            best = { el: btn, score: r.s, reasons: r.reasons }
    }
    // A real link or a styled div right beside the box whose whole label IS
    // the apply verb is a button too.
    const applyLabel = a => {
        const t = buttonLabel(a)
        return t.length <= 20 && APPLY_VERBS.some(w => has(t, w))
    }
    let p = input.parentElement
    for (let level = 0; level < 6 && p; level++, p = p.parentElement) {
        for (const b of p.querySelectorAll(BTN)) consider(b, level)
        if (level <= 2) {
            for (const a of p.querySelectorAll('a[href]'))
                if (applyLabel(a)) consider(a, level)
            for (const e of p.querySelectorAll('div, span')) {
                if (
                    applyLabel(e) &&
                    /btn|button|apply|submit/i.test(
                        String(e.className) + ' ' + e.id,
                    ) &&
                    !e.querySelector('input, button, a, select, textarea')
                )
                    consider(e, level)
            }
        }
    }
    const form = input.form
    if (form) {
        for (const b of form.querySelectorAll(BTN)) consider(b, 3)
        if (/^[\w-]+$/.test(form.id))
            for (const b of input.ownerDocument.querySelectorAll(
                `[form="${form.id}"]`,
            ))
                consider(b, 1)
    }
    return best
}

/* --------------------------------------------------------------- toggles */
// A toggle REVEALS a box on this page. A link that takes the shopper off
// their cart is never one.
function navigatesAway(el) {
    const a = el.closest('a[href]')
    if (!a) return false
    const h = (a.getAttribute('href') || '').trim()
    if (!h || /^(#|javascript:)/i.test(h)) return false
    try {
        const u = new URL(a.href, location.href)
        return (
            u.origin !== location.origin ||
            u.pathname !== location.pathname ||
            u.search !== location.search
        )
    } catch {
        return true
    }
}

function scoreToggle(el, t) {
    const reasons = []
    let s = 0
    const tag = el.tagName
    if (TOGGLE_RE.test(t) || TOGGLE_OBJ_RE.test(t)) {
        s += 50
        reasons.push('phrase')
    } else if (TOGGLE_TAIL_RE.test(t) && pointer(el)) {
        s += 45
        reasons.push('noun-then-verb')
    } else if (TOGGLE_BARE_RE.test(t)) {
        // A bare "Coupons" / "Promotions" is a menu item far more often than a
        // fold-out: it counts only with a disclosure signal.
        const inPageA =
            tag === 'A' &&
            /^\s*(#|javascript:)/i.test(el.getAttribute('href') || '')
        const namedTrigger =
            /(trigger|toggle|accordion|collaps|expand|reveal|disclos)/i.test(
                String(el.className) + ' ' + el.id,
            ) && pointer(el)
        // "Discount code" WITH the word code is a field's name, so a clickable
        // leaf saying it is a fold-out.
        const codeLeaf =
            /\bcodes?\b/i.test(t) &&
            !el.children.length &&
            tag !== 'A' &&
            pointer(el)
        const disclosure =
            tag === 'SUMMARY' ||
            el.hasAttribute('aria-expanded') ||
            el.hasAttribute('aria-controls') ||
            el.hasAttribute('data-toggle') ||
            el.hasAttribute('data-bs-toggle') ||
            !!el.closest('summary') ||
            inPageA ||
            namedTrigger ||
            codeLeaf
        if (!disclosure) return null
        s += 35
        reasons.push('bare')
    } else if (
        /^(enter|apply|show|view|open)( (one|it|code|now))?\s*[+▾▼›>→]?$/i.test(
            t,
        ) &&
        (tag === 'A' ||
            tag === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            pointer(el))
    ) {
        // A bare verb link beside a coupon row title ("Coupon/Gift
        // Certificate" ... "Enter"). Never a bare "Gift card" row: that is an
        // upsell.
        let label = ''
        for (
            let p = el.parentElement, k = 0;
            p && k < 3 && !label;
            p = p.parentElement, k++
        ) {
            const pt = norm(textOf(p))
            if (pt.length > 80) break
            const rest = norm(pt.replace(t, ' '))
            if (
                rest &&
                TOGGLE_BARE_RE.test(rest) &&
                /promo|coupon|discount|voucher|offer/i.test(rest)
            )
                label = rest
        }
        if (!label) return null
        s += 45
        reasons.push('verb-beside-label')
    } else if (
        /^(available|view|see|show) offers?\s*[+▾▼›>→]?$/i.test(t) &&
        (tag === 'BUTTON' || el.getAttribute('role') === 'button') &&
        pointer(el)
    ) {
        // An offers panel opened by a real BUTTON. Never a link: "Offers"
        // links are pages.
        s += 40
        reasons.push('offers-button')
    } else return null
    if (isDanger(t)) return null
    if (navigatesAway(el)) return null
    if (
        el.closest(
            'nav, footer, [role="navigation"], [class*="banner" i], [id*="banner" i], [class*="announcement" i]',
        )
    )
        return null
    // The SITE header only: an accordion's own <header> inside the basket is
    // the trigger itself.
    const hdr = el.closest('header')
    if (
        hdr &&
        !hdr.parentElement?.closest(
            'main, article, section, form, aside, [role="main"], [role="dialog"]',
        )
    )
        return null
    if (
        /\b(zip|postal|post ?code|postcode|tracking|track|referr\w*)\b/i.test(t)
    )
        return null
    // An ad naming a code ("Use code SAVE20") is not a box.
    if (/\bcode:?\s+[A-Z0-9][A-Z0-9-]{3,}\b/.test(t)) return null
    if (
        tag === 'BUTTON' ||
        tag === 'SUMMARY' ||
        el.getAttribute('role') === 'button' ||
        tag === 'A'
    ) {
        s += 20
        reasons.push('clickable')
    }
    // An OPEN disclosure is a click that closes the box.
    if (
        el.getAttribute('aria-expanded') === 'true' ||
        (tag === 'SUMMARY' && el.parentElement?.matches('details[open]'))
    )
        return null
    if (el.getAttribute('aria-expanded') === 'false') {
        s += 20
        reasons.push('aria-collapsed')
    }
    if (el.closest('details:not([open])')) {
        s += 15
        reasons.push('in-closed-details')
    }
    if (pointer(el)) {
        s += 10
        reasons.push('pointer')
    }
    return { s, reasons }
}

function findToggle(doc) {
    let best = null
    // Headings too: an accordion's trigger is often its <h3>.
    for (const el of doc.querySelectorAll(
        'button, a, summary, [role="button"], [aria-expanded], label, span, div, p, h2, h3, h4, header',
    )) {
        // Leaf-ish only: a div wrapping the whole sidebar also "says" promo.
        if (el.children.length > 3) continue
        // Cheap first (no layout): innerText below forces one per element.
        if (norm(el.textContent).length > 200) continue
        const t = norm(textOf(el))
        if (!t || t.length > 60) continue
        if (!visible(el)) continue
        const r = scoreToggle(el, t)
        if (!r) continue
        // Equal score: the INNERMOST element wins (an outer wrapper may not
        // open on a click at its centre; the row inside it does).
        if (
            !best ||
            r.s > best.score ||
            (r.s === best.score && best.el.contains(el))
        )
            best = { el, score: r.s, reasons: r.reasons }
    }
    return best
}

/* ----------------------------------------------------------------- total */
// The order total: the row labelled total (not subtotal, not one line's
// "items total") whose money value is readable. Visible rows win, then the
// last one in document order (the bottom line of a summary). A cart with no
// total row at all is read by its subtotal; never when a total row exists.
const TOTAL_LABEL =
    /^(order |estimated |grand |cart |basket |bag |your )?total( due| to pay| \(.*\))?:?$|^total\b|^(est\.?|estimated) (order )?total|^order total|^amount due|^total à payer|^gesamt|^summe|^totale/i
const TOTAL_NOT =
    /sub[- ]?total|sav(e|ed|ing|ings)\b|discount|items? total|total items|shipping|tax|points|weight|qty|quantity|calculated/i
const SUB_LABEL =
    /^(order |cart |merchandise |product |est\.? |estimated )?sub[- ]?total( \(.*\))?:?$|^product total:?$/i
const SUB_NOT = /sav(e|ed|ing|ings)\b|discount|shipping|tax|points/i
// An amount: a currency mark beside digits, or digits with cents.
const MONEY_RE =
    /(?:[$£€¥₹₩₺₱₪₫฿₦]|R\$|\b(?:USD|CAD|AUD|NZD|EUR|GBP|CHF|SEK|NOK|DKK|PLN|AED|SAR|INR|JPY|HKD|SGD|MXN|ZAR|kr)\b)\s?-?\d[\d.,]*|\d[\d.,]*\s?(?:[$£€¥₹₩₺₱₪₫฿₦]|\b(?:USD|EUR|GBP|CHF|kr)\b|zł)|\d[\d,]*[.,]\d{2}\b/i
const AMOUNT_ONLY = /^[^\w$£€¥₹₩₺₱₪₫฿₦]{0,3}\S{0,4}\s?-?\d[\d.,\s]*\S{0,4}$/
// A parenthetical ("incl. 15,17 € VAT") is commentary on the amount, not a
// second total.
const moneyCount = t =>
    (t.replace(/\(.*?\)/g, ' ').match(new RegExp(MONEY_RE.source, 'gi')) || [])
        .length
// One row: short, and holding exactly one amount. A block with two amounts
// (a struck-through price, a "free shipping over $150" line) is not a total
// we can read honestly, because its largest number need not be the total.
const ROW_MAX = 90

function scanTotalRows(doc, LABEL, NOT) {
    const hits = []
    const labels = new Set()
    const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n =>
            /total|amount due|gesamt|summe|totale/i.test(n.textContent)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_SKIP,
    })
    for (let n = tw.nextNode(); n; n = tw.nextNode())
        if (n.parentElement) labels.add(n.parentElement)
    for (const el of labels) {
        if (el.closest('script,style,noscript')) continue
        // A column heading labels every row under it, not one total. A header
        // row need not sit in <thead>: a <th> whose row holds no <td> is one.
        if (el.closest('thead, [role="columnheader"], th[scope="col"]'))
            continue
        const th = el.closest('th')
        if (th && !th.closest('tr')?.querySelector('td')) continue
        const own = norm(
            [...el.childNodes]
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent)
                .join(' '),
        )
        // The label may carry its own amount ("Bag total: £32.00 (1 Item)"):
        // judge the words with amount and parentheses cut.
        const bare = own
            .replace(/\(.*?\)/g, ' ')
            .replace(new RegExp(MONEY_RE.source, 'gi'), ' ')
            .replace(/\s+/g, ' ')
            .trim()
        if (
            !own ||
            own.length > 40 ||
            !(LABEL.test(own) || LABEL.test(bare)) ||
            NOT.test(own)
        )
            continue
        // The value sits in the same row: climb until an amount appears AFTER
        // the label. Too big to be one row: the value is the label's sibling.
        let p = el
        for (
            let i = 0, prev = null;
            i < 4 && p;
            i++, prev = p, p = p.parentElement
        ) {
            const t = norm(textOf(p))
            if (t.length > ROW_MAX || moneyCount(t) > 1) {
                const sib = (prev || el).nextElementSibling
                const st = sib ? norm(textOf(sib)) : ''
                if (
                    st.length <= 40 &&
                    AMOUNT_ONLY.test(st) &&
                    moneyCount(st) === 1
                )
                    hits.push({
                        el: sib,
                        visible: visible(sib),
                        label: bare.toLowerCase(),
                    })
                break
            }
            const after = t.slice(t.indexOf(own) + own.length)
            // "Total: calculated at the next step" has no amount yet; a number
            // found further up belongs to some other line.
            if (/^\W*(calculated|to be calculated|tbd)\b/.test(after)) break
            if (MONEY_RE.test(after)) {
                // A whole table body is a column of line totals, not one row.
                // A two-row summary table (label row, amount row) is refused
                // with it: that costs a page, never invents a total.
                if (/^(TBODY|THEAD|TFOOT|TABLE)$/.test(p.tagName)) break
                hits.push({
                    el: p,
                    visible: visible(p),
                    label: bare.toLowerCase(),
                })
                break
            }
        }
    }
    return hits
}

// The row, which kind it is, its label, and how many such rows the page
// shows. kind ('total' | 'subtotal') reads that kind only: a later read must
// measure the same row kind as the baseline did.
// Known limit: a cart measured on its subtotal (no total row) shows a code
// that discounts only shipping or tax as no saving at all. That costs a win,
// never invents one.
function findTotalRow(doc, kind) {
    let found = 'total'
    let hits =
        kind === 'subtotal' ? [] : scanTotalRows(doc, TOTAL_LABEL, TOTAL_NOT)
    if (!hits.length && kind !== 'total') {
        hits = scanTotalRows(doc, SUB_LABEL, SUB_NOT)
        found = 'subtotal'
    }
    const shown = hits.filter(h => h.visible)
    const pool = shown.length ? shown : hits
    if (!pool.length) return null
    const hit = pool[pool.length - 1]
    // rows counts every total row, shown or not, so a row that merely becomes
    // visible (a sticky mobile bar, an expanded summary) does not change it.
    return { el: hit.el, kind: found, label: hit.label, rows: hits.length }
}

/* The row a baseline measured, found again after the store re-rendered its
 * summary. `was` is { kind, label, rows } from that baseline. Fewer total
 * rows than the baseline saw means the summary is mid-render (a skeleton):
 * a line item's own "Total $19.99" may be all that is left, so nothing is
 * read. Otherwise the last row with the SAME label, shown rows first. */
// Known limits, both of which cost a win and never invent one: a store that
// renames the row after the apply ("Estimated total" to "Order total") or
// unmounts a hidden copy of it (a mobile drawer) reads as no change.
function findSameTotalRow(doc, was) {
    if (!was || typeof was.label !== 'string' || !(was.rows > 0)) return null
    const kind = was.kind === 'subtotal' ? 'subtotal' : 'total'
    const hits =
        kind === 'subtotal'
            ? scanTotalRows(doc, SUB_LABEL, SUB_NOT)
            : scanTotalRows(doc, TOTAL_LABEL, TOTAL_NOT)
    if (hits.length < was.rows) return null
    const same = hits.filter(h => h.label === was.label)
    const shown = same.filter(h => h.visible)
    const pool = shown.length ? shown : same
    return pool.length ? pool[pool.length - 1].el : null
}

// A total is only worth reading when it is a positive amount: zero is a
// placeholder caught mid-render (or an emptied cart), never a discounted total.
function positiveTotal(selector) {
    const now = getPrice(selector, { returnLargest: true })
    return now > 0 ? now : NaN
}

// Exported for tests/coupon-box-discovery.test.mjs.
export function caramelFindOrderTotal(doc = document) {
    return findTotalRow(doc)?.el || null
}

/* ---------------------------------------------------------------- decide */
// Exported for tests/coupon-box-discovery.test.mjs.
export function caramelDiscoverCouponBox(doc = document) {
    const candidates = scoreInputs(doc)
    const top = candidates[0] || null
    const button = top ? findButton(top.el) : null
    const toggle = !top || !top.visible ? findToggle(doc) : null
    return {
        input: top?.el || null,
        inputScore: top?.score || 0,
        inputVisible: !!top?.visible,
        button: button?.el || null,
        buttonScore: button?.score || 0,
        toggle: toggle?.el || null,
        reasons: {
            input: top?.reasons || [],
            button: button?.reasons || [],
            toggle: toggle?.reasons || [],
        },
    }
}

// Strong enough to type a code into? The field's OWN words (name, id,
// placeholder, label) are enough; context alone ("Promo code" heading over a
// bare field) is enough only with an apply button right beside it or in its
// own small form.
function confident(found) {
    if (!found.input || !found.button) return false
    if (found.input.disabled) return false
    const r = found.reasons.input
    if (r.some(x => x.startsWith('attr:') || x.startsWith('label:')))
        return true
    const b = found.reasons.button
    return (
        r.some(x => x.startsWith('ctx:')) &&
        b.some(x => x.startsWith('apply:')) &&
        (b.includes('adjacent') || b.includes('same-small-form'))
    )
}

const MARK = 'data-caramel-found'
const sel = kind => `[${MARK}="${kind}"]`

function mark(el, kind) {
    for (const old of el.ownerDocument.querySelectorAll(sel(kind)))
        old.removeAttribute(MARK)
    el.setAttribute(MARK, kind)
    return sel(kind)
}

/* Never click as a reveal toggle: an order-completing control, or any control
 * that would SUBMIT its form (a <button> with no type is a submit button). A
 * reveal never needs to submit; a submit posts the cart or, in a checkout
 * form, places the order behind an innocent label ("Have a promo code?"). */
function toggleRefused(el) {
    if (caramelIsForbiddenControl(el)) return true
    return (
        !!el.form &&
        ((el.tagName === 'BUTTON' && el.type === 'submit') ||
            (el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type)))
    )
}

/* Can the finder see a promo box on this page, without touching it?
 * Used by checkout detection, so it never clicks: a visible confident box, or a
 * reveal toggle, plus a readable total. */
// Called from store-detect.js.
export function caramelFinderSeesBox(doc = document) {
    const total = caramelFindOrderTotal(doc)
    if (!total || !readableTotal(total)) return false
    const found = caramelDiscoverCouponBox(doc)
    if (found.inputVisible && confident(found)) {
        log('FINDER_SEES_BOX', { reasons: found.reasons })
        return true
    }
    if (found.toggle && !toggleRefused(found.toggle)) {
        log('FINDER_SEES_TOGGLE', { reasons: found.reasons.toggle })
        return true
    }
    return false
}

/* A record the apply flow can run on, built from what the finder sees.
 *
 * Opens a folded promo box first when only its toggle is showing (refusing any
 * toggle that is an order-completing control). Marks the picks with
 * data-caramel-found so the apply flow reaches them through the same selector
 * machinery it uses for a config row, and sets caramelFound so the verdict
 * holds them to the money rule. Returns null when anything is missing: the
 * caller then keeps its own copy-the-codes answer. */
// Called from coupon-runner.js.
export async function caramelDiscoveredRecord(rec, doc = document) {
    const totalRow = findTotalRow(doc)
    const total = totalRow?.el
    // A row whose amount the price reader cannot parse ("12.00" with no
    // currency mark) gives no baseline: no code could ever be measured.
    if (!total || !readableTotal(total)) {
        log('FINDER_NO_TOTAL', {})
        return null
    }
    let found = caramelDiscoverCouponBox(doc)
    if (!found.inputVisible && found.toggle) {
        if (toggleRefused(found.toggle)) {
            log('AUTO_INSERT_REFUSED_CONTROL', {
                reason: 'the finder picked an order-completing control, or the submit button of a checkout form, as the promo toggle',
            })
            return null
        }
        found.toggle.click()
        for (let waited = 0; waited < 2500; waited += 250) {
            await sleep(250)
            found = caramelDiscoverCouponBox(doc)
            if (found.inputVisible) break
        }
    }
    if (!found.inputVisible || !confident(found)) {
        log('FINDER_NO_BOX', { reasons: found.reasons })
        return null
    }
    log('FINDER_PICKED', { reasons: found.reasons })
    const answer = answerArea(found.input, found.button)
    return {
        ...rec,
        couponInput: mark(found.input, 'input'),
        couponSubmit: mark(found.button, 'submit'),
        priceContainer: mark(total, 'total'),
        // Which row kind the baseline came from; every later read uses it.
        caramelTotalKind: totalRow.kind,
        // What the row looked like, so a re-rendered summary is found again
        // only as itself (see caramelFinderTotalNow).
        caramelTotalLabel: totalRow.label,
        caramelTotalRows: totalRow.rows,
        // Where the store answers: the box's own small container. Watching it
        // (coupon-apply.js caramelAwaitCouponVerdict) lets a refused code end
        // its wait the moment the store says something, instead of sitting out
        // the whole answer window. It never decides a success (the money rule
        // does) and is never quoted: it holds the field's own label too.
        caramelAnswer: answer ? mark(answer, 'answer') : null,
        // Everything else a config row says describes a page that is not this
        // one (that is why we are here): never click or read it.
        showInput: null,
        errorIndicator: null,
        dismissButton: null,
        successIndicator: null,
        couponRemove: null,
        caramelFound: true,
    }
}

// The smallest ancestor holding both the box and its button, if it is still
// a small region (a whole sidebar is not where one answer appears).
function answerArea(input, button) {
    let p = input.parentElement
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
        if (!p.contains(button)) continue
        return norm(textOf(p)).length <= 400 ? p : null
    }
    return null
}

/* The order total on a page the store just loaded after a finder submit.
 * The same reader as before the submit (a config's priceContainer on this
 * store described some other number), the same row kind (a subtotal read
 * against a total baseline would invent a saving) and, when the attempt
 * recorded it, the same row (see findSameTotalRow). NaN when there is no
 * such row, or its amount is not a positive total. */
// Called from store-detect.js.
export function caramelFinderReadTotal(doc = document, kind = 'total', was) {
    const el = was
        ? findSameTotalRow(doc, { ...was, kind })
        : findTotalRow(doc, kind === 'subtotal' ? 'subtotal' : 'total')?.el
    if (!el) return NaN
    return positiveTotal(mark(el, 'total'))
}

/* The finder's total, read now. NaN whenever it cannot be read honestly.
 *
 * A cart that re-renders its summary replaces the row we marked, so a marker
 * that no longer points at a shown row is put back, but only on the SAME row:
 * same kind, same label, and the page showing the same number of such rows as
 * when the baseline was read. While the summary is mid-render (a skeleton), a
 * line item's own "Total $19.99" can be the only total row on the page;
 * marking it would read a saving that never happened. A zero or negative total
 * is a placeholder caught mid-render, never an answer. */
// Called from coupon-apply.js.
export function caramelFinderTotalNow(rec, doc = document) {
    const el = doc.querySelector(rec.priceContainer)
    if (!el || !el.isConnected || !_isVisible(el)) {
        const row = findSameTotalRow(doc, {
            kind: rec.caramelTotalKind,
            label: rec.caramelTotalLabel,
            rows: rec.caramelTotalRows,
        })
        if (!row) return NaN
        mark(row, 'total')
    }
    return positiveTotal(rec.priceContainer)
}

// Read-only: detection must not move the marker or the last-read prices.
function readableTotal(el) {
    return caramelFindMoney(el.innerText || '').length > 0
}

/* Is the finder switched on? The background answers from its cached features
 * read; any failure to ask is answered as off. Asked once per page. */
let _discoveryOn = null
// Called from coupon-runner.js and store-detect.js.
export function caramelCouponBoxDiscoveryOn() {
    if (!_discoveryOn)
        _discoveryOn = caramelSendMessage({
            action: 'couponBoxDiscoveryEnabled',
        })
            .then(resp => resp?.enabled === true)
            .catch(() => false)
    return _discoveryOn
}

// Test seam: forget the per-page answer.
export function _caramelResetDiscoveryFlag() {
    _discoveryOn = null
}
