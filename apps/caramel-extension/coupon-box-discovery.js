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
//   · no total or subtotal row, no finder. A store found this way is judged by its
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
//
// When the rules see a total but no box, the server can be asked to pick one
// from an outline of the page (caramelPickedRecord, behind its own flag,
// couponBoxLlm). Its pick goes through the same record and the same apply
// flow as a rule pick, so every check after this point still runs.
import {
    caramelSendMessage,
    currentBrowser,
    log,
    sleep,
} from './caramel-base.js'
import {
    _isVisible,
    caramelFindMoney,
    caramelIsForbiddenControl,
    caramelSetLastPrices,
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
const ariaOf = el => el.getAttribute('aria-label')
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
        const own = ariaOf(q) || ''
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
        ariaOf(el),
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
    for (const el of doc.querySelectorAll('input')) {
        const c = scoreInput(el)
        if (c) candidates.push(c)
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates
}

// One field as the rules judge it: { el, score, reasons, visible }, or null
// when it is no candidate. A field someone else named (the server's pick, a
// remembered box) is typed into only when this accepts it too (couponInput).
function scoreInput(el) {
    if (el.type !== 'text' && el.type !== 'search') return null
    if (el.readOnly) return null
    const doc = el.ownerDocument
    const win = doc.defaultView
    const pageW = doc.documentElement.scrollWidth
    // A field parked far off-screen is a bot honeypot, not for people.
    const box = el.getBoundingClientRect()
    if (
        box.right + win.scrollX < -100 ||
        box.bottom + win.scrollY < -100 ||
        (pageW > 0 && box.left + win.scrollX > pageW + 100)
    )
        return null
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
    if (el.closest('[role="search"]') || /search|\/s\b|query/.test(action)) {
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
    if (score > 0 && evidence) return { el, score, reasons, visible: vis }
    return null
}

/* --------------------------------------------------------------- buttons */
const buttonLabel = el =>
    norm(
        el.innerText ||
            el.value ||
            ariaOf(el) ||
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
        if (spendsPoints(btn)) return
        if (noCodeClick(btn)) return
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

/* ------------------------------------------------------ points and offers */
// A click on "Apply discount" under "You have 500 points", on "Redeem points"
// or on "Use my rewards" spends the shopper's points or picks an offer for
// them, unasked, and no code is involved. The finder and the server's pick
// never click one, as a reveal or as an apply button. Only a CLICKED control
// is judged, by its own name and by the words beside it: a field labelled
// "Promo or rewards code" is still a coupon box, and the plain "Apply" beside
// it is still clicked, because those words name a code. A configured store
// never reaches this: its own selectors are clicked as written.
const LOYALTY_RE =
    /\b(?:redeem(?:s|ed|ing)?|points?|rewards?|loyalty|memberships?)\b/i
const CODE_WORD_RE = /\b(?:codes?|coupons?|vouchers?)\b/i
// A reveal named only for offers or promotions opens a list of offers, not a
// box to type a code into.
const OFFERS_RE = /\b(?:offers?|promotions?|deals?)\b/i

// Text with a space between every node: "You have 500 points" and "Apply
// discount" in two elements must not read as "pointsApply".
const wordsOf = el =>
    Array.from(el.childNodes, n =>
        n.nodeType === 3 ? n.data : n.nodeType === 1 ? wordsOf(n) : '',
    ).join(' ')

const controlWords = el =>
    [
        wordsOf(el),
        ariaOf(el),
        el.value,
        el.title,
        el.getAttribute('name'),
        el.id,
    ]
        .join(' ')
        .replace(/[-_]+/g, ' ')

// The words a shopper reads beside a control: the small block around it, or,
// once a block also holds a field, only its own neighbours. A neighbour that IS
// a field speaks by its label (the box this button applies); one that holds a
// field is another box and says nothing about this control.
function wordsBeside(el) {
    let words = ''
    for (let n = el, k = 0; k < 3; n = n.parentElement, k++) {
        const p = n.parentElement
        if (!p || p === el.ownerDocument.body) break
        if (p.querySelector(FIELDS)) {
            for (const sib of [n.previousElementSibling, n.nextElementSibling])
                if (sib?.matches(FIELDS)) words += ' ' + labelText(sib)
                else if (sib && !sib.querySelector(FIELDS))
                    words += ' ' + wordsOf(sib)
            break
        }
        if (norm(p.textContent).length > 160) break
        words = wordsOf(p)
    }
    return words
}

// Called for every control the finder or the pick might click. A control
// that names points or rewards itself is refused unless it also names a code;
// a bare "Redeem", or "Apply discount" under a points balance, is judged with
// the words beside it.
function spendsPoints(el) {
    const own = controlWords(el)
    if (LOYALTY_RE.test(own.replace(/\bredeem\w*/gi, '')))
        return !CODE_WORD_RE.test(own)
    const words = own + ' ' + wordsBeside(el)
    return LOYALTY_RE.test(words) && !CODE_WORD_RE.test(words)
}

// A field that takes points rather than a code ("Points to redeem"). Pressing
// Enter in it is the same as clicking its "Redeem" button.
const pointsField = el => {
    const words = [
        labelText(el),
        el.placeholder,
        ariaOf(el),
        el.name,
        el.id,
    ].join(' ')
    return LOYALTY_RE.test(words) && !CODE_WORD_RE.test(words)
}

const offersOnly = el => {
    const own = controlWords(el)
    return OFFERS_RE.test(own) && !CODE_WORD_RE.test(own)
}

/* ------------------------------------------------- never a code's click */
// Never clicked on any path (the rules, the server's pick, a box remembered
// here or by other installs): a control that adds to the cart or buys, adds a
// gift extra, protection, a warranty, insurance or a donation, saves or
// updates the cart, subscribes, or signs the shopper in or up. Judged by its
// own words (controlWords), so a cross-sell "Add to cart" beside the box is
// refused whatever named it. "Gift card or discount code" names a code and is
// still a promo-box reveal.
const NO_CODE_CLICK_RE =
    /\badd(?:ing)? (?:it )?to (?:my |your |the )?(?:cart|bag|basket|order)\b|\bbuy\b|\bprotection\b|\bwarrant(?:y|ies)\b|\binsurance\b|\bdonat(?:e|ion)s?\b|\bround(?:ing)? ?up\b|\b(?:save|update) (?:my |your |the )?(?:cart|bag|basket|qty|quantit(?:y|ies))\b|\bsave for later\b|\bsubscri(?:be|ption)s?\b|\bnewsletters?\b|\bsign(?:ing)? ?(?:in|up)\b|\blog ?in\b/i
const GIFT_EXTRA_RE =
    /\bgift ?(?:card|wrap\w*|message|note|receipt|box|bag)s?\b/i
const PROMO_WORD_RE = /\b(?:promo\w*|coupons?|discounts?|vouchers?)\b/i

function noCodeClick(el) {
    const words = controlWords(el)
    return (
        NO_CODE_CLICK_RE.test(words) ||
        (GIFT_EXTRA_RE.test(words) && !PROMO_WORD_RE.test(words))
    )
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

// The checkbox this element is, labels, or wraps. null for anything else.
function checkboxOf(el) {
    const c =
        el.tagName === 'LABEL'
            ? el.control
            : el.tagName === 'INPUT'
              ? el
              : el.querySelector('input[type="checkbox"], input[type="radio"]')
    return c?.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(c.type)
        ? c
        : null
}

// Does this control fold away THE box that holds `input`? It names the box's
// region in aria-controls, or the smallest ancestor holding both is one small
// panel rather than the whole cart.
function ownsBox(el, input) {
    if (!el || !input) return false
    for (const id of (el.getAttribute('aria-controls') || '').split(/\s+/)) {
        const region = id && el.ownerDocument.getElementById(id)
        if (region && region.contains(input)) return true
    }
    const doc = el.ownerDocument
    let p = el.parentElement
    for (let i = 0; i < 5 && p; i++, p = p.parentElement)
        if (p.contains(input))
            return (
                p !== doc.body &&
                p !== doc.documentElement &&
                norm(p.textContent).length <= 400
            )
    return false
}

// A checkbox beside the box that says promo is far more often a setting than
// a fold, and sitting in the same small panel does not tell them apart. So it
// must speak of ENTERING a code ("Have a promo code?", "Toggle discount code
// input", "Got a coupon?"), never of a card, a balance or points ("I have a
// discount card", "Use my voucher balance"), and never ask for consent ("Email
// me promo codes and offers").
const CODE_ENTRY_RE =
    /\b(?:promo(?:tional)?|coupon|discount|voucher|offer|gift)\s+codes?\b|\b(?:have|got|enter|add|apply|use)\s+(?:a|an|your)?\s*(?:promo(?:tional)?|coupon|discount|voucher)\b(?!\s+(?:card|balance|points))/i
const CONSENT_RE =
    /\b(?:e-?mail|sms|text me|newsletter|subscri\w*|sign me up|send me|notif\w*|marketing)\b/i

// What a toggle says. A checkbox says it in its accessible name.
// An icon with no text is named by its aria-label (castlery: a "+" button
// labelled "Add coupon code").
function toggleText(el) {
    return norm(
        el.tagName === 'INPUT'
            ? ariaOf(el) || labelText(el)
            : textOf(el).trim() || ariaOf(el),
    )
}

function scoreToggle(el, t) {
    const reasons = []
    let s = 0
    const tag = el.tagName
    if (tag === 'INPUT') {
        // A CSS-only fold (a transparent checkbox over "Have a discount
        // code?"). findToggle lets one through only when it holds the box.
        if (!CODE_ENTRY_RE.test(t)) return null
        s += 50
        reasons.push('owned-checkbox')
    } else if (TOGGLE_RE.test(t) || TOGGLE_OBJ_RE.test(t)) {
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

const TOGGLE_SEL =
    'button, a, summary, [role="button"], [aria-expanded], label, span, div, p, h2, h3, h4, header, input[type="checkbox"]'

// `input` is the hidden promo field, when there is one.
function findToggle(doc, input) {
    let best = null
    // Headings too: an accordion's trigger is often its <h3>.
    for (const el of doc.querySelectorAll(TOGGLE_SEL)) {
        // Leaf-ish only: a div wrapping the whole sidebar also "says" promo.
        if (el.children.length > 3) continue
        // Cheap first (no layout): innerText below forces one per element.
        if (norm(el.textContent).length > 200) continue
        // A click on a checkbox CHANGES the order ("Use my gift card
        // balance"). One is a toggle only when it folds the promo box itself
        // and says so.
        // A box that only renders once its fold is checked has no input to
        // own yet: then a label or wrapper may still open it (what its words
        // say decides), but a bare checkbox never.
        // A radio is never a fold: it picks one option of a group (a payment
        // method), and a second click cannot put the shopper's pick back.
        const check = checkboxOf(el)
        if (check?.type.toLowerCase() === 'radio') continue
        if (check && (input ? !ownsBox(el, input) : el.tagName === 'INPUT'))
            continue
        const t = toggleText(el)
        if (check && (!CODE_ENTRY_RE.test(t) || CONSENT_RE.test(t))) continue
        if (!t || t.length > 60) continue
        if (!visible(el)) continue
        if (spendsPoints(el) || offersOnly(el)) continue
        if (noCodeClick(el)) continue
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
    /sub[- ]?total|sav(ed?|ings?)\b|discount|items? total|total items|shipping|tax|points|weight|qty|quantity|calculated/i
const SUB_LABEL =
    /^(order |cart |merchandise |product |est\.? |estimated )?sub[- ]?total( \(.*\))?:?$|^product total:?$/i
const SUB_NOT = /sav(ed?|ings?)\b|discount|shipping|tax|points/i
// A currency sign. One spelling, shared by every money pattern below.
const SIGN = '[$£€¥₹₩₺₱₪₫฿₦]'
// ...and the currency codes written beside an amount.
const CODES =
    'USD|CAD|AUD|NZD|EUR|GBP|CHF|SEK|NOK|DKK|PLN|AED|SAR|INR|JPY|HKD|SGD|MXN|ZAR|kr'
// An amount: a currency mark beside digits, or digits with cents.
const MONEY_RE = new RegExp(
    `(?:${SIGN}|R\\$|\\b(?:${CODES})\\b)\\s?-?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:${SIGN}|\\b(?:USD|EUR|GBP|CHF|kr)\\b|zł)|\\d[\\d,]*[.,]\\d{2}\\b`,
    'i',
)
const AMOUNT_ONLY = new RegExp(
    `^[^\\w${SIGN.slice(1, -1)}]{0,3}\\S{0,4}\\s?-?\\d[\\d.,\\s]*\\S{0,4}$`,
)
// A parenthetical ("incl. 15,17 € VAT") is commentary on the amount, not a
// second total.
const moneyCount = t =>
    (t.replace(/\(.*?\)/g, ' ').match(new RegExp(MONEY_RE.source, 'gi')) || [])
        .length
// One row: short, and holding exactly one amount. A block with two amounts
// (a struck-through price, a "free shipping over $150" line) is not a total
// we can read honestly, because its largest number need not be the total.
const ROW_MAX = 90

// An element's own words, and the same with amount and parentheses cut: a
// label may carry its own amount ("Bag total: £32.00 (1 Item)").
function ownLabel(el) {
    const own = norm(
        [...el.childNodes]
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent)
            .join(' '),
    )
    const bare = own
        .replace(/\(.*?\)/g, ' ')
        .replace(new RegExp(MONEY_RE.source, 'gi'), ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return { own, bare }
}

function scanTotalRows(
    doc,
    LABEL,
    NOT,
    { root = doc.body, words = /total|amount due|gesamt|summe|totale/i } = {},
) {
    const hits = []
    const labels = new Set()
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n =>
            words.test(n.textContent)
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
        const { own, bare } = ownLabel(el)
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
            // A label the store hides (WooCommerce's responsive table draws it
            // from the cell's data-title instead) is not in the shown text:
            // the row's own words are. Measured live: the Total row read as
            // "$150.00" alone, the subtotal was measured, and a cart coupon
            // that took $6 off the total never counted.
            // Only the hidden LABEL is put back: the row's other hidden text
            // (a compare-at price, a screen-reader amount) stays out.
            let t = norm(textOf(p))
            if (!t.includes(own)) t = norm(own + ' ' + t)
            if (t.length > ROW_MAX || moneyCount(t) > 1) {
                const sib = (prev || el).nextElementSibling
                const st = sib ? norm(textOf(sib)) : ''
                if (
                    st.length <= 40 &&
                    AMOUNT_ONLY.test(st) &&
                    moneyCount(st) === 1
                ) {
                    // The whole row is judged, and the line must end at its
                    // amount counting everything after the value cell. A
                    // summary drawn as one flat grid makes the "row" the
                    // whole summary, so a coupon line there is refused, not
                    // netted: "Minimum order total | $50.00" is drawn exactly
                    // like "Shipping | $4.00", and no word list told them
                    // apart (three reviews, each a false saving).
                    let end = ''
                    for (let n = sib; n; n = n.nextSibling)
                        if (n.nodeType === 1) end += ' ' + textOf(n)
                        else if (n.nodeType === 3) end += n.textContent
                    hits.push({
                        el: sib,
                        row: textOf(sib.parentElement),
                        end,
                        line: textOf(el) + ' ' + end,
                        visible: visible(sib),
                        label: bare.toLowerCase(),
                    })
                }
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
// never invents one. (A code shown as its own coupon line is read: see
// finderTotal.)
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

/* A cart with no total row is measured on its subtotal, and many such carts
 * take a code off on a line of its own beneath it ("Coupon -$20.00") and leave
 * the subtotal where it was. Measured live: the store said "$20.00 Off", the
 * subtotal stayed $99.99, and the shopper was told the code did not stick.
 *
 * So the read before a code (the baseline) records the subtotal and what its
 * summary already says, shown or not: every amount in it and every label that
 * speaks of a discount. A later read takes off one line the code added. Each
 * rule below keeps it from claiming money that did not move:
 *  - a subtotal that itself moved answers alone: a store whose subtotal is
 *    already net of the code also lists the line, and both would count;
 *  - the line must be in plain view, under a label the summary did not show
 *    before, with one amount marked as a deduction ("-$20.00", "($20.00)")
 *    that the summary did not hold before: an old line the summary unfolds,
 *    or re-draws with a new amount, is not the code's, and a "requires a
 *    minimum purchase of $50.00" message is not a discount;
 *  - one code is one deduction: the largest new line is taken, never a sum,
 *    so a summary line and its per-item shares count once;
 *  - a deduction the store printed beside a rejection of the code is not a
 *    saving (coupon-apply.js reads rec.caramelNetted for that).
 * A read with no baseline (a fresh page after a reload) takes off nothing. */
const DISCOUNT_WORDS = /coupon|discount|promo|voucher/i
const DISCOUNT_LABEL =
    /^(?:order |cart |basket )?(?:coupon|discount|promo(?:tion)?|voucher)s?(?: code)?\b[^.!?]{0,30}$/i
const DISCOUNT_NOT =
    /total|sav(ed?|ings?)\b|shipping|tax|eligible|exclud|cannot|can't|only|enter|apply|add |have|gift|points|reward|member|minimum|spend|purchase|requir|more|qualif|valid|expire|balance|credit|card|not appl|pending|up to/i
// A coupon line nets in ONE shape only: its label, at most a code name, ONE
// amount marked as a deduction ("-$5.00", "- $ 5.00", "$-5.00", "($5.00)"),
// then only a currency code or a Remove/Edit control. Anything else on the
// line is not read: a threshold ("Orders over 150"), "up to", "next order",
// a note in brackets. Five reviews each found a phrasing a list of refusal
// words missed; a shape needs no list. A dash inside a word ("SPRING-$10")
// is not a minus, and the only name a line may carry is the code that was
// typed: "(INACTIVE)" looks like a code and is a status. Only ASCII
// punctuation may follow the amount; a note in any script is words.
const LINE_LABEL =
    /^\W*(?:(?:order|cart|basket) )?(?:coupon|discount|promo(?:tion)?|voucher)s?(?: code)?(?: applied)?\b:?/i
const PUNCT = '[\\s.,;:!?()[\\]|/*×✕-]'
const LINE_TAIL = new RegExp(
    `\\s*(?:${CODES}|zł)?(?:${PUNCT}+(?:remove|edit|change|delete)(?:${PUNCT}+(?:coupon|code|discount|promo|voucher)){0,2})?${PUNCT}*$`,
    'i',
)
const CUR = `(?:${SIGN}|\\b(?:${CODES}))\\s?`
const LINE_AMOUNT = new RegExp(
    `(?:^|[\\s\\u200e\\u200f:()"'“”])(?:[-−–]\\s*(?:${CUR})?|${SIGN}[-−–]|\\(\\s?(?:${CUR})?)\\d[\\d.,]*\\s?(?:${SIGN})?\\)?$`,
)
function isCouponLine(line, typed) {
    const s = line
        .replace(/\s+/g, ' ')
        .replace(LINE_LABEL, '')
        .replace(LINE_TAIL, '')
    const m = s.match(LINE_AMOUNT)
    if (!m) return false
    const code = s
        .slice(0, m.index)
        .trim()
        .replace(/\s*\bapplied\b:?$/i, '')
        .replace(/^["'“‘([]+|["'”’)\]:]+$/g, '')
    return !code || (!!typed && code.toLowerCase() === typed.toLowerCase())
}

// The subtotal's own summary: the widest ancestor still small enough to be
// one panel rather than the whole cart. Sized by textContent, which needs no
// layout: this runs on every read of a polling wait.
function summaryOf(el) {
    const doc = el.ownerDocument
    let scope = null
    for (
        let p = el.parentElement, i = 0;
        p && i < 6;
        p = p.parentElement, i++
    ) {
        if (p === doc.body || p === doc.documentElement) break
        if ((p.textContent || '').replace(/\s+/g, ' ').length > 1500) break
        scope = p
    }
    return scope
}

// What the summary says before a code, from its text nodes, hidden or not:
// every amount, and the label of every element that speaks of a discount.
function summaryBefore(el) {
    const scope = el && summaryOf(el)
    if (!scope) return { scope, amounts: [], labels: [] }
    const amounts = []
    const labels = []
    const tw = el.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        for (const m of caramelFindMoney(n.textContent))
            amounts.push(Math.abs(m.value))
        if (n.parentElement && DISCOUNT_WORDS.test(n.textContent))
            labels.push(ownLabel(n.parentElement).bare.toLowerCase())
    }
    return { scope, amounts, labels }
}

// The one deduction the code added, or 0. Read in the baseline's own summary
// while the page still has it: a summary re-derived after the store removed
// a long paragraph can climb wider and take in rows the baseline never saw.
function newDeduction(el, base) {
    const scope = base.scope?.isConnected ? base.scope : el && summaryOf(el)
    if (!scope) return 0
    const hits = scanTotalRows(el.ownerDocument, DISCOUNT_LABEL, DISCOUNT_NOT, {
        root: scope,
        words: DISCOUNT_WORDS,
    }).filter(
        h => h.visible && !h.el.contains(el) && !base.labels.includes(h.label),
    )
    let off = 0
    for (const h of hits) {
        if (hits.some(o => o !== h && o.el.contains(h.el))) continue
        // A code in brackets ("Coupon (SAVE20)") names the code, not an amount.
        const t = textOf(h.el).replace(/\(\s*[\w-]*[a-z][\w-]*\s*\)/gi, ' ')
        const money = caramelFindMoney(t)
        const a = money.length === 1 ? Math.abs(money[0].value) : 0
        // The whole row is judged, not only its label or value cell: "Promo
        // code -$5.00 not applied (minimum $50.00)" is a refusal. A deduction
        // line ends at its amount: "Promo code - $5.00 off your next order"
        // and a bulleted note are not one.
        if (
            a > off &&
            isCouponLine(h.line || textOf(h.el), base.code) &&
            (!h.end || caramelFindMoney(h.end).length === 1) &&
            !DISCOUNT_NOT.test(h.row || textOf(h.el)) &&
            !base.amounts.includes(a)
        )
            off = a
    }
    return off
}

function finderTotal(selector, kind, doc, rec, baseline, code) {
    if (rec) {
        rec.caramelNetted = false
        if (baseline) rec.caramelSubtotalBase = null
    }
    const gross = positiveTotal(selector)
    if (kind !== 'subtotal' || !(gross > 0) || !rec) return gross
    const el = doc.querySelector(selector)
    if (baseline) {
        rec.caramelSubtotalBase = { gross, code, ...summaryBefore(el) }
        return gross
    }
    const base = rec.caramelSubtotalBase
    if (!base || base.gross !== gross) return gross
    const off = newDeduction(el, base)
    if (!off) return gross
    const net = Math.round((gross - off) * 100) / 100
    // A coupon line as big as the whole subtotal is not one we can read.
    if (!(net > 0)) return NaN
    caramelSetLastPrices([net])
    rec.caramelNetted = true
    return net
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
    const toggle = !top || !top.visible ? findToggle(doc, top?.el) : null
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
    if (caramelIsForbiddenControl(el) || spendsPoints(el) || offersOnly(el))
        return true
    if (noCodeClick(el)) return true
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

/* The rules see no box, but the server could still find one once the shopper
 * taps. Without this the server pick is unreachable: the prompt only appeared
 * where the rules already saw a box, and a page where they did had no reason
 * to ask. So, only while the couponBoxLlm flag is on, a cart page with a
 * readable total is offered the prompt too.
 *
 * Detection still never asks the server or clicks anything: the pick runs
 * after the tap (caramelPickedRecord), once per store per tab session, and a
 * "no box" answer ends with the codes handed over to copy. A store already
 * asked this session is not offered again on the strength of this rule. */
//
// Three things a cart URL and a total row do not prove, each refused here:
// the order is already placed (a thank-you page under /checkout/ still shows
// a "Total"), the cart is empty (a "$0.00" subtotal), and the total row is one
// the shopper cannot see (a closed mini-cart drawer on the home page the
// shopper reached from /cart).
// Called from store-detect.js.
export async function caramelFinderMayAsk(domain, doc = document) {
    if (!(await caramelCouponBoxLlmOn())) return false
    if (ORDER_PLACED_PATH_RE.test(doc.location?.pathname || '')) return false
    if (pickAsked(domain || doc.location?.hostname)) return false
    if (!shownPositiveTotal(doc)) return false
    log('FINDER_MAY_ASK', {})
    return true
}

/* A path a store shows AFTER the order is placed: WooCommerce
 * /checkout/order-received/123/, Magento /checkout/onepage/success/, Shopify
 * /checkouts/c/<token>/thank-you, and the plain /order-confirmation. The word
 * must be a whole part of a path segment, so /products/success-kit is not one
 * only by accident of a prefix. */
const ORDER_PLACED_PATH_RE =
    /(?:^|[/\-_])(?:order[-_]?received|order[-_]?(?:confirmation|confirmed|complete|completed)|thank[-_]?you|thanks|success|confirmation)(?:[/.]|$)/i

/* Is there a total row the shopper can see, holding an amount above zero?
 * findTotalRow falls back to a hidden row because the apply flow may measure
 * one; whether to OFFER anything is decided only on what is in view. */
function shownPositiveTotal(doc) {
    for (const [label, not] of [
        [TOTAL_LABEL, TOTAL_NOT],
        [SUB_LABEL, SUB_NOT],
    ]) {
        const shown = scanTotalRows(doc, label, not).filter(h => h.visible)
        if (!shown.length) continue
        const row = shown[shown.length - 1].el
        return caramelFindMoney(row.innerText || '').some(m => m.value > 0)
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
//
// On a store with no config (rec.caramelNoConfig), two things come first: a
// box this install saw the store answer through before (learnedRecord), and,
// per the server's couponBoxPickMode, the server's pick:
//   · rules_first: the rules, then the server only when they find nothing;
//   · llm_first: the server first, then the rules when it names no usable box
//     (no box, no pick, a refusal, a timeout, an error);
//   · llm_only: the server alone. The rules never find the box, so a miss is
//     a miss; the checks on the pick and the money rule still run.
// A store with a served config is always rules_first and never reads or saves
// a learned box.
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
    const served = isServed(rec)
    const mode = await pickMode(served)
    if (!served) {
        const learned = await learnedRecord(rec, doc, mode)
        if (learned) return learned
    }
    if (mode !== RULES_FIRST) {
        const picked = await caramelPickedRecord(rec, doc, mode)
        if (picked || mode === LLM_ONLY) return picked
        log('FINDER_PICK_FALLBACK', { mode })
    }
    let found = caramelDiscoverCouponBox(doc)
    const opened = found.inputVisible ? null : found.toggle
    if (!found.inputVisible && found.toggle) {
        if (toggleRefused(found.toggle)) {
            log('AUTO_INSERT_REFUSED_CONTROL', {
                reason: 'finder toggle completes the order or submits a checkout form',
            })
            return null
        }
        const toggle = found.toggle
        const check = checkboxOf(toggle)
        const wasChecked = check?.checked
        toggle.click()
        for (let waited = 0; waited < 2500; waited += 250) {
            await sleep(250)
            found = caramelDiscoverCouponBox(doc)
            if (found.inputVisible) break
        }
        // A checkbox that opened no box we can use was not its fold, or not
        // one worth keeping open: put it back the way the shopper left it.
        if (
            (!found.inputVisible || !confident(found)) &&
            check &&
            check.checked !== wasChecked
        ) {
            log('FINDER_TOGGLE_RESTORED', {})
            toggle.click()
        }
    }
    if (!found.inputVisible || !confident(found)) {
        log('FINDER_NO_BOX', { reasons: found.reasons })
        // In llm_first the server was asked above: this finds only a pick it
        // kept for this page.
        return caramelPickedRecord(rec, doc, mode)
    }
    log('FINDER_PICKED', { reasons: found.reasons })
    return learnable(finderRecord(rec, found, totalRow, opened), 'rules', {
        found,
        opened,
    })
}

// The record for a box the finder settled on: `found` holds a visible input
// and its button, `opened` the toggle clicked to reveal them (or null).
// `found.button` is null only for a box the server said has no apply button
// (it applies on Enter): couponSubmit then names the input itself, the shape the
// apply flow already runs (coupon-apply.js: applyBtn === input types the code
// and presses Enter, no click).
function finderRecord(rec, found, totalRow, opened) {
    const answer = answerArea(found.input, found.button || found.input)
    const inputSel = mark(found.input, 'input')
    return {
        ...rec,
        couponInput: inputSel,
        couponSubmit: found.button ? mark(found.button, 'submit') : inputSel,
        priceContainer: mark(totalRow.el, 'total'),
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
        // The box as itself, so a re-drawn one is found again only as itself
        // (caramelRemarkFoundBox).
        caramelInputSig: inputSig(found.input),
        // The toggle that opened a folded box. A store that re-draws the box
        // folded again (WooCommerce, after every answer) gets it opened again
        // before the next code, the way a config's toggle is.
        showInput: opened?.isConnected ? mark(opened, 'toggle') : sel('toggle'),
        // Its words, so the toggle of a re-drawn box is known as the same one.
        caramelToggleSig: opened ? toggleText(opened) || null : null,
        // Everything else a config row says describes a page that is not this
        // one (that is why we are here): never click or read it.
        errorIndicator: null,
        dismissButton: null,
        successIndicator: null,
        couponRemove: null,
        caramelFound: true,
    }
}

/* ------------------------------------------------------- the server's pick */
// The rules saw a readable total but no box. With the couponBoxLlm flag on,
// the server is asked once, from an outline of the page (coupon-box-outline.js:
// element names only, digits and emails scrubbed, only allowlisted words, no
// page text), which element is the box, its apply button, or the toggle that
// reveals it.
//
// Its answer is a suggestion, checked here before anything is touched:
//   · each pick must still be on the page; the input must be a field the apply
//     flow can type into (a text or search <input>, enabled, writable);
//   · a button or toggle must not be an order, pay, remove, sign-in or
//     leave-the-cart control (the server refuses these too);
//   · a toggle alone is clicked once, and then the RULES must find the box it
//     revealed. Nothing else is ever clicked on the server's word.
// What survives becomes the same record a rule pick does (finderRecord), so
// the apply flow, the coupon-evidence check and the money rule all still run.
// Any other answer, a refusal or a failure to ask leaves the page exactly as
// the rules left it: no box, and the codes handed over to copy.
//
// At most one ask per store per tab session, whatever came back. A usable
// pick is also kept, by name (keptPick), for the next page in the tab: a cart
// that reloads to show the store's answer gets its box found again there.
const PICK_KEY = 'caramel_box_pick:'
// How long the page waits for the answer. The server gives the model 20s and
// then answers no_pick itself; the background allows the whole ask (flag
// read, token read, request) COUPON_BOX_PICK_DEADLINE_MS, 24s (background.js);
// 5s more covers waking a stopped background worker, the message hops and
// reading the answer (the background's clock starts only once it is awake),
// so an answer sent inside that deadline arrives here. Raise one, raise the
// ones after.
export const PICK_WAIT_MS = 29000
// The outline builder (coupon-box-outline.js) is not in the content-script
// bundle: the build ships it as this file and it is loaded only by a page that
// is about to ask.
const OUTLINE_MODULE = 'assets/coupon-box-outline.js'
// Labels the server refuses to click, mirrored for the button and the toggle.
const NEVER_CLICK =
    /check ?out|place (?:my |your )?order|\bpay\b|pay ?pal|pay now|buy now|purchase|\bremove\b|\bdelete\b|empty (?:cart|basket|bag)|sign ?in|sign ?up|log ?in|register|create (?:an )?account|subscribe|continue/i
const _pickAsked = new Set()

// The one spelling of a store in the asked-memory: the prompt gate reads it
// with whatever domain it was handed, the pick writes it with the record's.
const pickKey = domain =>
    String(domain || '')
        .trim()
        .toLowerCase()

function pickAsked(domain) {
    domain = pickKey(domain)
    if (_pickAsked.has(domain)) return true
    try {
        return sessionStorage.getItem(PICK_KEY + domain) !== null
    } catch (err) {
        // Storage blocked: this page's own memory is all there is.
        log('FINDER_PICK_STORAGE', { error: String(err) })
        return false
    }
}

function rememberPick(domain, kept = '1') {
    domain = pickKey(domain)
    _pickAsked.add(domain)
    try {
        sessionStorage.setItem(PICK_KEY + domain, kept)
    } catch (err) {
        log('FINDER_PICK_STORAGE', { error: String(err) })
    }
}

// The names a usable pick left for later pages in this tab, or null: the ask
// found nothing usable, storage is blocked (pickAsked logs that), or this is
// not the page the pick was made on. A form-POST cart comes back to its own
// path; a checkout page with a "code" field of its own is not that page.
function keptPick(domain, doc) {
    try {
        const k = JSON.parse(sessionStorage.getItem(PICK_KEY + pickKey(domain)))
        return k?.i && k.p === doc.location?.pathname ? k : null
    } catch {
        return null
    }
}

// What an element is and what it is called: its tag, then its stable name
// (inputSig), or for a toggle ('t') its words. A kept input ('i') is named
// only by its field name or id: a placeholder or label ("Enter code") is
// worn by a gift-card field too. '' when nothing names it.
function pickName(el, how) {
    const n = el && (how === 't' ? toggleText(el) : inputSig(el))
    return n && (how !== 'i' || /^[ni]:/.test(n)) ? el.tagName + ' ' + n : ''
}

// The kept pick on this page. Each name must fit exactly one element (a wrapper
// says what the control inside it says, so only the innermost counts): a name
// that also fits a gift-card field would put the codes there.
function refindPick(doc, k) {
    const find = (css, name, how) => {
        if (!name) return null
        const m = [...doc.querySelectorAll(css)].filter(
            el => pickName(el, how) === name,
        )
        const inner = m.filter(e => !m.some(o => o !== e && e.contains(o)))
        return inner.length === 1 ? inner[0] : null
    }
    return {
        input: find('input', k.i, 'i'),
        button: find(TOGGLE_SEL + ',input', k.b, 'b'),
        toggle: find(TOGGLE_SEL, k.t, 't'),
    }
}

/* A box someone else named (the server's pick, a pick kept from the last
 * page, a box remembered here or by other installs) passes the coupon-word
 * checks a box the rules find passes, on top of the click guards. */

// Its field: what the rules would accept (scoreInput: a coupon word in its
// own name, label, placeholder or aria-label, or in the short region around
// it, and no sign of a search, an address or a newsletter box), never a field
// that takes points.
const couponInput = el => !!scoreInput(el) && !pointsField(el)

// Its apply button says so: an apply word (Apply, Redeem, Use code, Submit,
// OK...) in its label, or, on an arrow or an icon, in its aria-label, title
// or value. Never one whose label also says checkout, pay or the like.
const ARROWS_RE = /^[\s→›>»▶➔➜➝➞⟶↵⏎]*$/u
function applyLike(btn) {
    const text = buttonLabel(btn)
    if (text.length > 40) return false
    if (isDanger(text) && !APPLY_VERBS.some(w => has(text, w))) return false
    const says = t => APPLY_WORDS.some(w => has(t, w))
    return (
        says(text) ||
        (ARROWS_RE.test(text) &&
            says(norm([ariaOf(btn), btn.title, btn.value].join(' '))))
    )
}

// Its toggle names a CODE ("Have a promo code?", "Add a coupon", "Discount
// code", "Gutscheincode eingeben"), never a card, a balance or points, and
// never asks for consent to mail.
const CODE_WORD_TOGGLE_RE =
    /\b(?:promo|coupon|discount|voucher|rabatt|gutschein|aktions|kortings)codes?\b/i
function codeToggle(el) {
    const t = toggleText(el)
    const words = norm(t + ' ' + (ariaOf(el) || ''))
    return (
        (CODE_ENTRY_RE.test(words) ||
            TOGGLE_OBJ_RE.test(t) ||
            CODE_WORD_TOGGLE_RE.test(words)) &&
        !CONSENT_RE.test(words)
    )
}

// A checkbox, radio or switch changes a setting of the order (a balance used,
// a payment picked), and one named by someone else is never clicked: it is
// no reveal a click can safely try.
const SWITCHES =
    'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitemcheckbox"], [role="menuitemradio"], [aria-checked]'
const switchLike = el =>
    !!checkboxOf(el) || !!el.closest(SWITCHES) || !!el.querySelector(SWITCHES)

// A toggle clicked on someone else's word: one the shopper can see, that
// names a code, never an order, pay, remove or leave-the-cart control (nor a
// part of one: a <span> inside a submit button submits its form), and never a
// checkbox, radio or switch.
const okToggle = t =>
    visible(t) &&
    clickable(t) &&
    codeToggle(t) &&
    !switchLike(t) &&
    !toggleRefused(t.closest('button') || t) &&
    !navigatesAway(t)

// An apply button says apply and never leaves the page: a link elsewhere is a
// way out of the cart, whatever it says.
const okButton = (b, input) =>
    clickable(b) && applyLike(b) && b !== input && !navigatesAway(b)

// The apply button for `input`: the one named, else the one the rules see
// beside it. After a reload (a kept pick) either is used only when it is this
// box's own: in its form, or in its small panel. A page that re-drew the box
// beside a gift-card form must not lend it that form's button.
// strict (llm_only): the named button only, never one the rules find.
function applyButtonFor(input, button, kept, strict) {
    const ok = b =>
        b &&
        !navigatesAway(b) &&
        (!kept || (b.form ? b.form === input.form : ownsBox(b, input)))
    return [button, !strict && findButton(input)?.el].find(ok) || null
}

/* The rules see no box, but this tab's kept pick names one here: the cart
 * reloaded to show the store's answer to the last code. Clicks nothing, and
 * says yes only where the run could go on: a box with its button (or none,
 * for a box kept as applying on Enter), or the toggle that opened it. */
// Called from store-detect.js.
export async function caramelFinderSeesKeptPick(
    domain,
    doc = document,
    strict = false,
) {
    const k =
        (await caramelCouponBoxLlmOn()) &&
        keptPick(domain || doc.location?.hostname, doc)
    if (!k || !shownPositiveTotal(doc)) return false
    const sees = boxShows(refindPick(doc, k), k.e, strict)
    if (sees) log('FINDER_SEES_KEPT', {})
    return sees
}

/* Can the finder see a box a run could use on this page, without touching
 * it? The rules' box (never in llm_only, where the rules find nothing), the
 * pick kept from the last page in this tab, or, on a store with no config, a
 * box this install remembers. `served`: the store has a served config, so it
 * is rules_first and never reads a learned box. */
// Called from store-detect.js.
export async function caramelFinderSees(domain, served, doc = document) {
    const mode = await pickMode(served)
    return (
        (mode !== LLM_ONLY && caramelFinderSeesBox(doc)) ||
        (await caramelFinderSeesKeptPick(domain, doc, mode === LLM_ONLY)) ||
        (!served && (await learnedSees(domain, doc, mode)))
    )
}

// Could a run go on with these elements, without clicking anything? A
// showing box with its own button (or none, for a box that applies on Enter),
// or the toggle that opens it.
function boxShows({ input, button, toggle }, enterOnly, strict) {
    return (
        (typeableInput(input) &&
            visible(input) &&
            couponInput(input) &&
            (!!applyButtonFor(
                input,
                okButton(button, input) && button,
                true,
                strict,
            ) ||
                !!enterOnly)) ||
        okToggle(toggle)
    )
}

// The element the server named by index, if it is still on the page.
const pickedEl = (elements, n) =>
    Number.isInteger(n) && elements[n]?.isConnected ? elements[n] : null

function typeableInput(el) {
    return (
        !!el &&
        el.tagName === 'INPUT' &&
        (el.type === 'text' || el.type === 'search') &&
        !el.disabled &&
        !el.readOnly
    )
}

function clickable(el) {
    if (!el || /^(TEXTAREA|SELECT)$/.test(el.tagName)) return false
    // Of the <input>s only a button, or a checkbox that folds the box, is a
    // control; a text field never is.
    if (
        el.tagName === 'INPUT' &&
        !/^(button|submit|image|checkbox)$/.test(el.type)
    )
        return false
    const words = [textOf(el), ariaOf(el), el.value, el.title].join(' ')
    return (
        !caramelIsForbiddenControl(el) &&
        !NEVER_CLICK.test(words) &&
        !spendsPoints(el) &&
        !noCodeClick(el)
    )
}

// Ask the server once, from an outline of the page. null on any miss.
async function askPick(domain, doc) {
    let outline, elements
    try {
        const { caramelPageOutline } = await import(
            /* @vite-ignore */ currentBrowser.runtime.getURL(OUTLINE_MODULE)
        )
        ;({ outline, elements } = caramelPageOutline(doc.body))
    } catch (err) {
        // The builder did not load or failed: a miss like any other.
        log('FINDER_PICK_MISS', {
            outline: String(err?.message || err),
        })
        return null
    }
    let answer
    try {
        answer = await caramelSendMessage(
            { action: 'couponBoxPick', domain, outline },
            PICK_WAIT_MS,
        )
    } catch (err) {
        log('FINDER_PICK_MISS', { error: String(err?.message || err) })
        return null
    }
    if (answer?.outcome !== 'box') {
        log('FINDER_PICK_MISS', {
            outcome: answer?.outcome || null,
            reason: answer?.reason || answer?.error || null,
        })
        return null
    }
    // A box other installs saw this store answer through is named by
    // selectors (under `box`, the shape the report carried), not by places in
    // this page's outline; its index fields are null. Each selector must be in
    // the learned-box grammar and find exactly one element here
    // (learnedEls); everything after this point checks it like any pick.
    if (answer.source === 'learned' && answer.box) {
        try {
            return { learned: true, ...(await learnedEls(doc, answer.box)) }
        } catch (err) {
            log('FINDER_PICK_MISS', { learned: String(err?.message || err) })
            return null
        }
    }
    return {
        answer,
        input: pickedEl(elements, answer.input),
        button: pickedEl(elements, answer.button),
        toggle: pickedEl(elements, answer.toggle),
        enterOnly: answer.button == null,
    }
}

// Called from caramelDiscoveredRecord: after the rules found no box, or, in
// the llm modes, before them.
async function caramelPickedRecord(rec, doc, mode) {
    if (!(await caramelCouponBoxLlmOn())) return null
    const domain = pickKey(rec.domain || doc.location?.hostname)
    if (!domain) return null
    const kept = keptPick(domain, doc)
    let picked
    if (kept) picked = { ...refindPick(doc, kept), enterOnly: !!kept.e }
    else {
        if (pickAsked(domain)) return null
        rememberPick(domain)
        picked = await askPick(domain, doc)
        if (!picked) return null
    }
    const learned = kept ? !!kept.l : !!picked.learned
    const got = await checkedPick(doc, picked, !!kept, mode === LLM_ONLY)
    if (!got) return null
    const { found, opened, total } = got
    log('FINDER_PICK_USED', {
        confidence: picked.answer?.confidence ?? null,
        toggle: !!opened,
        kept: !!kept,
        learned,
        reasons: found.reasons || null,
    })
    // Kept only when each name finds exactly this element again, here: a name
    // this page already shares with another field would not find the box
    // after the reload either.
    const k = {
        p: doc.location?.pathname,
        i: pickName(found.input, 'i'),
        b: pickName(found.button, 'b'),
        t: pickName(opened, 't'),
        // Applies on Enter: there is no button to find again.
        ...(found.button ? {} : { e: 1 }),
        // A box other installs confirmed, not the model's pick.
        ...(learned ? { l: 1 } : {}),
    }
    const again = refindPick(doc, k)
    if (
        !kept &&
        again.input === found.input &&
        again.button === (k.b ? found.button : null) &&
        again.toggle === (k.t ? opened : null)
    )
        rememberPick(domain, JSON.stringify(k))
    return learnable(
        finderRecord(rec, found, total, opened),
        learned ? 'server_learned' : 'llm',
        { found, opened, learned },
    )
}

/* Check a box someone else named (the server's pick, a pick kept from the
 * last page, a box remembered from an earlier visit) on this page, before
 * anything is touched. `picked` holds the elements and whether the box
 * applies on Enter; `own` asks that a button be the box's own (in its form,
 * or its small panel); `strict` (llm_only) that the rules find nothing, not
 * even the box a named toggle reveals or a button beside the named input.
 * Returns { found, opened, total } or null. */
async function checkedPick(doc, picked, own, strict) {
    // The cart may have re-rendered while the server answered: the baseline is
    // the total as it is now, and with no readable total nothing can be
    // measured.
    const total = findTotalRow(doc)
    if (!total?.el || !readableTotal(total.el)) {
        log('FINDER_NO_TOTAL', { after: 'pick' })
        return null
    }

    let { input, button, toggle } = picked
    if (!typeableInput(input) || !couponInput(input)) input = null
    if (!okButton(button, input)) button = null
    if (!okToggle(toggle)) toggle = null
    const buttonFor = el => applyButtonFor(el, button, own, strict)

    // A usable pick: an input with its button, or the named input when no
    // button was named (a box that applies on Enter). A button that was named
    // but this page refused above (a link out of the cart, an order control)
    // never turns into an Enter press: that stays a miss. A kept pick is
    // Enter-only only when it was made that way: a box kept with a button that
    // the reload took away is a miss.
    const usableBox = f =>
        !!f?.input && (!!f.button || (f.input === input && picked.enterOnly))

    let found = null
    let opened = null
    if (input && visible(input)) {
        found = { input, button: buttonFor(input) }
    } else if (toggle) {
        toggle.click()
        for (let waited = 0; waited < 2500 && !found; waited += 250) {
            await sleep(250)
            // The named input once it shows, else whatever box the rules can
            // now see.
            if (input && visible(input) && typeableInput(input))
                found = { input, button: buttonFor(input) }
            else if (!strict) {
                const rules = caramelDiscoverCouponBox(doc)
                // Same guard as buttonFor: a button that leaves the page is
                // never the apply button on this path.
                if (rules.inputVisible && confident(rules))
                    found = {
                        ...rules,
                        button:
                            rules.button && !navigatesAway(rules.button)
                                ? rules.button
                                : null,
                    }
            }
        }
        opened = toggle
    }
    if (!usableBox(found)) {
        log('FINDER_PICK_UNUSABLE', {
            input: !!input,
            button: !!button,
            toggle: !!toggle,
        })
        return null
    }
    return { found, opened, total }
}

/* ------------------------------------------------------- learned boxes */
// A box the store answered through (the total dropped, or the store replied
// about the code) on a store with no config is remembered for this install
// (coupon-box-learned.js keeps the memory: storage.local, at most 200
// domains, forgotten after two failed uses in a row), and, while the
// couponBoxLlm flag is on, reported to the server, which serves a box several
// installs confirmed back as a pick (source 'learned', askPick).
//
// What is saved and sent is the box's selectors and where it came from:
// never page text, a code or a price.
const LEARNED_MODULE = 'assets/coupon-box-learned.js'
const LEARNED_KEY = 'caramel_learned_boxes'
// The box a run on this tab is using, for the page a submit reloads to.
const LEARN_KEY = 'caramel_box_learn:'
const isServed = rec => rec?.caramelNoConfig !== true

const loadLearned = () =>
    import(/* @vite-ignore */ currentBrowser.runtime.getURL(LEARNED_MODULE))

// The box this install remembers for `domain`, or null.
function learnedBox(domain) {
    return new Promise(resolve => {
        try {
            currentBrowser.storage.local.get([LEARNED_KEY], items => {
                const b = items?.[LEARNED_KEY]?.[domain]
                resolve(b?.v === 1 && typeof b.input === 'string' ? b : null)
            })
        } catch (err) {
            log('FINDER_LEARNED_UNREADABLE', { error: String(err) })
            resolve(null)
        }
    })
}

// A learned box's elements, each the one element its selector finds
// (coupon-box-learned.js caramelOne: a selector outside the learned-box
// grammar is never queried). Rejects when the module does not load.
async function learnedEls(doc, b) {
    const { caramelOne } = await loadLearned()
    return {
        input: caramelOne(doc, b.input),
        button: caramelOne(doc, b.apply),
        toggle: caramelOne(doc, b.toggle),
        enterOnly: b.enterOnly === true && !b.apply,
    }
}

// llm_only lets the server alone find a box: a box the rules found once is
// not used then.
const learnedFor = async (domain, mode) => {
    const b = await learnedBox(pickKey(domain))
    return b && !(mode === LLM_ONLY && b.source === 'rules') ? b : null
}

/* Tried first on a store with no config. A box that no longer resolves here,
 * or fails the checks, counts as a failed use (two and it is forgotten), and
 * detection goes on as if there were none. */
async function learnedRecord(rec, doc, mode) {
    const b = await learnedFor(rec.domain, mode)
    if (!b) return null
    let els
    try {
        els = await learnedEls(doc, b)
    } catch (err) {
        // Nothing was tried: not a failed use of the box.
        log('FINDER_LEARN_UNAVAILABLE', { error: String(err?.message || err) })
        return null
    }
    const got = await checkedPick(doc, els, true, mode === LLM_ONLY)
    if (!got) {
        log('FINDER_LEARNED_UNUSABLE', {})
        // Only this install's memory: whether it applies here is not news
        // about the box for anyone else.
        learnOutcome(
            { domain: pickKey(rec.domain), box: b, source: b.source },
            'failed',
            null,
            false,
        )
        return null
    }
    // A named toggle can reveal a box the rules then pick, and a stale button
    // name gives way to the button the rules see beside the box (checkedPick):
    // then what runs is the rules' find, not the remembered box.
    const now = await learnedEls(doc, b)
    const same =
        got.found.input === now.input &&
        (got.found.button || null) === (b.apply ? now.button : null)
    log('FINDER_LEARNED_USED', { source: b.source, same })
    return learnable(
        finderRecord(rec, got.found, got.total, got.opened),
        same ? b.source : 'rules',
        same ? { ...got, learned: true, box: b } : got,
    )
}

/* Can a remembered box be used here, without touching anything? For the
 * prompt and the reload chain, the same question caramelFinderSeesKeptPick
 * answers for a kept pick. */
async function learnedSees(domain, doc, mode) {
    const b = await learnedFor(domain || doc.location?.hostname, mode)
    if (!b || !shownPositiveTotal(doc)) return false
    let els
    try {
        els = await learnedEls(doc, b)
    } catch (err) {
        log('FINDER_LEARN_UNAVAILABLE', { error: String(err?.message || err) })
        return false
    }
    const sees = boxShows(els, els.enterOnly, mode === LLM_ONLY)
    if (sees) log('FINDER_SEES_LEARNED', {})
    return sees
}

/* Give a record on a store with no config what it needs to remember its box:
 * the box's selectors (built by coupon-box-learned.js, each checked to find
 * exactly its element) and where it came from. A box with no stable name is
 * not remembered, and the record is returned either way. */
async function learnable(record, source, { found, opened, learned, box }) {
    if (isServed(record)) return record
    const domain = pickKey(record.domain)
    let l
    try {
        l = (await loadLearned()).caramelLearnable(
            domain,
            box || [found.input, found.button, opened],
            source,
            learned,
        )
    } catch (err) {
        log('FINDER_LEARN_UNAVAILABLE', { error: String(err?.message || err) })
        return record
    }
    if (!l) {
        log('FINDER_LEARN_NO_NAME', {})
        return record
    }
    try {
        sessionStorage.setItem(LEARN_KEY + domain, JSON.stringify(l))
    } catch (err) {
        log('FINDER_PICK_STORAGE', { error: String(err) })
    }
    return { ...record, caramelLearn: l }
}

/* What a run taught us about its box. `confirmed` with its evidence
 * ('total_dropped' or 'store_answered'), once per run; `failed` only for a
 * box that came from memory (this install's or the server's) and got no
 * answer from the store at all. Saved for this install, then reported to the
 * server; both results are logged, and neither can touch the shopper's run. */
// Called from coupon-runner.js.
export function caramelFinderLearn(rec, outcome, evidence = null) {
    const l = rec?.caramelLearn
    if (!l || l.done || (outcome === 'failed' && !l.learned)) return
    l.done = true
    return learnOutcome(l, outcome, evidence, true)
}

/* The page a submit reloaded to measured the total drop: the box the run
 * used is confirmed. */
// Called from store-detect.js.
export function caramelFinderLearnResumed(domain) {
    const key = LEARN_KEY + pickKey(domain)
    let l = null
    try {
        l = JSON.parse(sessionStorage.getItem(key))
        sessionStorage.removeItem(key)
    } catch (err) {
        log('FINDER_PICK_STORAGE', { error: String(err) })
    }
    if (l?.box)
        return caramelFinderLearn(
            { caramelLearn: l },
            'confirmed',
            'total_dropped',
        )
}

// Saved, then reported (coupon-box-learned.js caramelLearnOutcome logs each).
const learnOutcome = (l, outcome, evidence, report) =>
    loadLearned()
        .then(m =>
            m.caramelLearnOutcome(
                {
                    area: currentBrowser.storage.local,
                    send: report && caramelSendMessage,
                    log,
                },
                l,
                outcome,
                evidence,
            ),
        )
        .catch(err =>
            log('FINDER_LEARNED_SAVE_FAILED', {
                outcome,
                error: String(err?.message || err),
            }),
        )

// What a box IS, by its most stable name: the field name the server reads,
// then its id, then the words it carries. Only that one name is compared, so
// a label that gains the store's error, or a placeholder rewritten after an
// answer, does not make the same box a stranger. '' when nothing names it: a
// wordless box cannot be told from another wordless box (a gift-card field
// beside it), so it is never found again.
// An id a framework generates (React ':r1:', 'mui-12', 'ember123') is new on
// every re-draw, so it names nothing: the next key is read instead.
const GENERATED_ID_RE =
    /:|^(?:mui|ember|radix|headlessui|react|rc|chakra|downshift|field|input)[-_]?\d|(?=[0-9a-f]*\d)[0-9a-f]{8,}/i
const SIG_KEYS = [
    ['n', el => el.getAttribute('name')],
    ['i', el => (GENERATED_ID_RE.test(el.id) ? '' : el.id)],
    ['a', ariaOf],
    ['p', el => el.getAttribute('placeholder')],
    ['l', el => labelText(el)],
]
function inputSig(el) {
    for (const [key, get] of SIG_KEYS) {
        const v = norm(get(el))
        if (v) return key + ':' + v
    }
    return ''
}
function sameBox(el, sig) {
    const get = SIG_KEYS.find(([key]) => sig.startsWith(key + ':'))?.[1]
    return !!get && sig.slice(2) !== '' && norm(get(el)) === sig.slice(2)
}

/* Mark the box again after the store re-drew it. Some carts replace the whole
 * promo section to show their answer, and the marks went with the old nodes:
 * the answer was never seen and the next code had no box to go into.
 *
 * Only the SAME box (rec.caramelInputSig): while ours is disabled for the
 * request, a gift-card field beside it scores higher, and every later code
 * would be typed there. A box re-drawn folded is marked with its toggle, which
 * the apply flow opens (showInput), and only a toggle of THIS box: the one that
 * opened it before, or one in its own small panel. A page-wide pick could be
 * "Have a gift card?", and the next code would click it. Clicks nothing. true
 * when the box (and, if asked, its answer area) is marked. */
// Called from coupon-apply.js.
export function caramelRemarkFoundBox(answerToo, rec, doc = document) {
    // A box picked with no apply button (finderRecord) has no 'submit' mark:
    // its couponSubmit is the input's own selector.
    const inputOnly = !!rec && rec.couponSubmit === rec.couponInput
    const marked = doc.querySelector(sel('input'))
    if (
        marked &&
        visible(marked) &&
        (inputOnly || doc.querySelector(sel('submit'))) &&
        (!answerToo || doc.querySelector(sel('answer')))
    )
        return true
    const sig = rec?.caramelInputSig
    if (!sig) return false
    // With no button beside the field to confirm it, the rules' own evidence
    // on the field must (see inputOnlyBox), and one box only: two fields that
    // carry the same name are not told apart, so neither is typed into.
    const same = scoreInputs(doc).filter(c => sameBox(c.el, sig))
    const sure = inputOnly ? same.filter(inputOnlyBox) : same
    if (inputOnly && sure.length !== 1) return false
    const top = sure[0]
    const button = inputOnly ? null : top && findButton(top.el)
    const found = {
        input: top?.el,
        button: button?.el,
        reasons: { input: top?.reasons || [], button: button?.reasons || [] },
    }
    // The same name already identified the box; with no button to confirm it
    // the name is all there is.
    if (inputOnly ? !top : !confident(found)) return false
    let toggle = null
    if (!top.visible) {
        const t = findToggle(doc, top.el)?.el
        if (
            !t ||
            toggleRefused(t) ||
            !(
                (rec.caramelToggleSig &&
                    toggleText(t) === rec.caramelToggleSig) ||
                ownsBox(t, top.el)
            )
        )
            return false
        toggle = t
    }
    log('FINDER_REMARKED', { reasons: found.reasons, folded: !!toggle })
    mark(found.input, 'input')
    if (found.button) mark(found.button, 'submit')
    if (toggle) mark(toggle, 'toggle')
    const answer = answerArea(found.input, found.button || found.input)
    if (answer) mark(answer, 'answer')
    return !answerToo || !!answer
}

/* Is a field the rules scored one we may press Enter in with no button to
 * confirm it? What confident() asks of the input alone (its own attribute or
 * label names a coupon), and none of the exclusions scoreInputs records: a
 * search box, a field that scored as a different kind (neg:), a gift-card
 * field. */
function inputOnlyBox(c) {
    const r = c.reasons
    return (
        r.some(x => x.startsWith('attr:') || x.startsWith('label:')) &&
        !r.some(
            x =>
                x === 'in-search' ||
                x === 'gift-only' ||
                x.startsWith('neg:') ||
                (x.startsWith('weak:') && x.includes('gift')),
        )
    )
}

// Where the store answers: the smallest ancestor holding both the box and its
// button (if it is still a small region; a whole sidebar is not where one
// answer appears), widened by up to three levels while it stays small. Stores
// print the answer just outside the box's own row as often as inside it.
function answerArea(input, button) {
    let p = input.parentElement
    for (let i = 0; i < 5 && p && !p.contains(button); i++) p = p.parentElement
    if (!p || !p.contains(button) || norm(textOf(p)).length > 400) return null
    let area = p
    for (
        let up = 0, q = p.parentElement;
        up < 3 && q && q !== q.ownerDocument.body;
        up++, q = q.parentElement
    ) {
        if (norm(textOf(q)).length > 600) break
        area = q
    }
    return area
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
    return finderTotal(mark(el, 'total'), kind, doc, null, false)
}

/* The finder's total, read now. NaN whenever it cannot be read honestly.
 *
 * A cart that re-renders its summary replaces the row we marked, so a marker
 * that no longer points at a shown row is put back, but only on the SAME row:
 * same kind, same label, and the page showing the same number of such rows as
 * when the baseline was read. While the summary is mid-render (a skeleton), a
 * line item's own "Total $19.99" can be the only total row on the page;
 * marking it would read a saving that never happened. A zero or negative total
 * is a placeholder caught mid-render, never an answer. baseline marks the
 * read before a code is tried (see finderTotal). */
// Called from coupon-apply.js.
export function caramelFinderTotalNow(
    rec,
    doc = document,
    baseline = false,
    code = '',
) {
    // A baseline read that fails below must not leave the last code's
    // baseline (and its code name) for this code's later reads.
    if (baseline) rec.caramelSubtotalBase = null
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
    return finderTotal(
        rec.priceContainer,
        rec.caramelTotalKind,
        doc,
        rec,
        baseline,
        code,
    )
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
            .catch(e => {
                log('FINDER_FLAG_UNREADABLE', { error: String(e) })
                return false
            })
    return _discoveryOn
}

/* May the finder ask the server to pick a box the rules missed, and in which
 * order (the server's couponBoxPickMode)? Read the same way, from the
 * couponBoxLlm flag: any failure to ask is off, and off, or a mode this build
 * does not know, is rules_first. */
const RULES_FIRST = 'rules_first'
const LLM_ONLY = 'llm_only'
const PICK_MODES = [RULES_FIRST, 'llm_first', LLM_ONLY]
let _llm = null
function llmFlags() {
    if (!_llm)
        _llm = caramelSendMessage({ action: 'couponBoxLlmEnabled' })
            .then(resp => {
                const on = resp?.enabled === true
                return {
                    on,
                    mode:
                        on && PICK_MODES.includes(resp.mode)
                            ? resp.mode
                            : RULES_FIRST,
                }
            })
            .catch(err => {
                log('FINDER_PICK_FLAG', { error: String(err?.message || err) })
                return { on: false, mode: RULES_FIRST }
            })
    return _llm
}
const caramelCouponBoxLlmOn = () => llmFlags().then(f => f.on)
// The mode for a record: a store with a served config is always rules_first.
const pickMode = served => (served ? RULES_FIRST : llmFlags().then(f => f.mode))

// Test seam: forget the per-page answers.
export function _caramelResetDiscoveryFlag() {
    _discoveryOn = null
    _llm = null
    _pickAsked.clear()
}
