// owns: DOM visibility/wait helpers, price parsing, CSS/XPath query helpers, the mid-attempt navigation handoff (_isVisible, waitForVisible, pickBestMatch, waitForElement, waitForTextChange, waitUntilReady, getPrice, _isXPath, qOne, qAll, caramel{Mark,Clear,Take}PendingSubmit)
// load after: caramel-base.js
//
// ES module since the WXT P1 port (2026-08-12). Module scope replaces the
// script global scope; the `oxlint-disable-next-line no-unused-vars` pragmas
// that only existed because oxlint's per-file analysis cannot see a cross-file
// content-script call are gone, because `export` is now that statement. The
// file has NO top-level side effects — no listeners, no DOM reads, no chrome
// API calls, no window publication — so it exports no init function.
import { log } from './caramel-base.js'

/* ---------- DOM waiters ---------- */
/* ---------- visibility helpers ---------- */
// "Can the user actually see this?" — checkVisibility() correctly handles
// display:none ancestors (collapsed accordions), visibility:hidden and
// content-visibility, and (unlike the old offsetParent test) doesn't
// false-negative inside position:fixed/sticky containers, where order-summary
// rails and their coupon UIs commonly live.
export function _isVisible(el) {
    if (!el) return false
    try {
        if (typeof el.checkVisibility === 'function')
            return el.checkVisibility()
    } catch {
        /* fall through to the legacy heuristic */
    }
    return el.offsetParent !== null
}
// Wait until the selector matches a VISIBLE element. waitForElement only waits
// for presence — useless for reveal-toggles that unhide pre-rendered markup
// (the input already "exists" while still display:none). Checks ALL matches,
// not just the first: generic selectors often also hit hidden templates.
// Called from other split content-script files (see store-detect.js's
// startCheckoutDetection for why per-file analysis misses cross-file calls).
export function waitForVisible(sel, timeout = 3000) {
    return new Promise((res, rej) => {
        const t0 = performance.now()
        ;(function poll() {
            if (qAll(sel).some(_isVisible)) return res('visible')
            if (performance.now() - t0 > timeout)
                return rej(`waitForVisible timeout (${sel})`)
            setTimeout(poll, 120)
        })()
    })
}
// Pick the best element among ALL matches of a config selector. Config
// selectors are often generic on purpose (Magento's `.title[data-role=title]`
// matches EVERY accordion section — Estimate Shipping, Gift Cards, the promo
// block…), and querySelector's "first match" can land on a hidden or wrong
// section. Generic disambiguation, no store logic:
//   1. if an anchor is given (usually the coupon input), prefer the match
//      sharing the SMALLEST containing block with it — the promo toggle sits
//      in the same block as the promo input; unrelated accordions don't;
//   2. otherwise prefer a VISIBLE match;
//   3. otherwise fall back to the first match.
/* Controls the extension must NEVER activate, whatever a config says.
 *
 * pickBestMatch falls back to "first visible match on the page" when nothing
 * sits near the coupon input. That is the right call for a promo toggle, but it
 * means a stale or over-broad apply/showInput selector (`button[type=submit]`
 * and friends) can resolve to the checkout's own order-completing control — and
 * the apply path dispatches a FULL pointer+click sequence, which such buttons
 * happily accept. A wrong config should cost the user a missed discount, never
 * an order placed with their saved payment method.
 *
 * Matched on the control's visible label and its accessible/name attributes.
 * A coupon apply button is never called "Pay now" or "Place order", so this
 * cannot swallow a legitimate target.
 *
 * Vocabulary scope: manifest.json matches https://*./* — every locale, not just
 * English — so the order verbs cover the languages our store list actually
 * reaches. Cart destruction ("empty cart") and session destruction ("log out")
 * are here for the same reason order placement is: a stale selector that
 * resolves to one costs the user their cart or their session, and the QA sweep
 * on 2026-08-05 clicked all three. */
const CARAMEL_FORBIDDEN_CONTROL_RE =
    /\b(place\s+(your\s+)?order|pay\s+(now|today)|complete\s+(your\s+)?(order|purchase)|submit\s+order|confirm\s+(and\s+pay|order|purchase)|buy\s+now|proceed\s+to\s+(pay|checkout)|checkout\s+now|delete\s+account)\b|\b(remove|delete)\s+(this\s+)?(item|product|line|all|address|card|everything|from\s+(bag|cart|basket|order))\b|\b(empty|clear)\s+(your\s+)?(cart|bag|basket|trolley)\b|\b(log|sign)\s*out\b|\b(jetzt\s+kaufen|kauf(en)?\s+abschlie(ss|ß)en|zahlungspflichtig\s+bestellen|bestellung\s+abschicken|commander(\s+et\s+payer)?|payer\s+maintenant|valider\s+(la\s+)?commande|realizar\s+(el\s+)?pedido|comprar\s+ahora|pagar\s+ahora|finalizar\s+(la\s+)?compra|acquista\s+ora|procedi\s+al\s+pagamento)\b/i

/* Every string a sighted or assistive-tech user would read as this control's
 * label. The guard used to read five properties; the QA sweep placed real
 * orders through three labelling patterns none of them covered — an icon
 * button labelled by <img alt>, by aria-labelledby, or by title=. Those are
 * not exotic: they are the three standard ways to label a button that shows
 * only an icon, which is exactly what checkout "pay" buttons often are. */
function _caramelControlLabelParts(el) {
    const parts = [
        el.innerText || el.textContent || '',
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('title') || '',
        el.value || '',
        el.getAttribute?.('name') || '',
        el.id || '',
    ]
    // aria-labelledby points at the element(s) holding the real label.
    const labelledBy = el.getAttribute?.('aria-labelledby') || ''
    for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
        try {
            const ref = el.ownerDocument?.getElementById(id)
            if (ref) parts.push(ref.innerText || ref.textContent || '')
        } catch {
            /* a malformed id is not a reason to skip the rest */
        }
    }
    // An icon button's only human-readable text is often its image's alt.
    try {
        for (const img of el.querySelectorAll?.('img[alt], svg title') || [])
            parts.push(img.getAttribute?.('alt') || img.textContent || '')
    } catch {
        /* ditto */
    }
    return parts
}

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export function caramelIsForbiddenControl(el) {
    if (!el) return false
    // id/name attributes spell the same words with separators ("pay-now",
    // "submit_order"), so flatten those to spaces before matching.
    return CARAMEL_FORBIDDEN_CONTROL_RE.test(
        _caramelControlLabelParts(el).join(' ').replace(/[-_]+/g, ' '),
    )
}

/* Fields that mean "submitting this form spends money". Matched on the
 * autocomplete tokens the HTML spec defines for payment instruments, plus the
 * name/id shapes checkouts use when they don't set autocomplete. */
const CARAMEL_PAYMENT_FIELD_SEL =
    'input[autocomplete^="cc-"], input[name*="cardnumber" i], input[name*="card_number" i], input[name*="cvv" i], input[name*="cvc" i], input[id*="cardnumber" i], input[id*="cardNumber"]'

/* Would activating this control submit something other than the coupon?
 *
 * The label guard above asks "is this element an order button". That is not
 * enough, because two proven order-placement paths never touch a labelled
 * order button at all: an apply button of type="submit" sitting inside the
 * checkout's own <form>, and the unconditional Enter keydown, which submits
 * whatever form the coupon input happens to live in. In both the element we
 * inspect is innocent ("Apply Discount") and the FORM is the danger.
 *
 * So this guards the ACTION rather than the element: a form carrying payment
 * credentials, or containing a control the label guard would refuse, is a form
 * we must never submit. A correctly-configured store is unaffected — Magento's
 * #discount-coupon-form and WooCommerce's .checkout_coupon are their own forms
 * and contain neither. */
export function caramelFormSubmitIsUnsafe(el) {
    let form = null
    try {
        form = el?.form || el?.closest?.('form') || null
    } catch {
        return false
    }
    // No owning form means there is no implicit submission to worry about.
    if (!form) return false
    try {
        if (form.querySelector(CARAMEL_PAYMENT_FIELD_SEL)) return true
        for (const control of form.querySelectorAll(
            'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]',
        ))
            if (caramelIsForbiddenControl(control)) return true
    } catch {
        /* an unreadable form is not evidence of safety, but it is also not
           evidence of danger — fall through to the caller's other checks */
    }
    return false
}

/* The most visible matches a coupon selector can have and still plausibly be
 * pointing at a coupon control.
 *
 * A promo input or its reveal toggle is ONE element. Configs legitimately list
 * a few alternatives ("#a, .b, [c]") and themes sometimes render a mobile and a
 * desktop copy, so a handful is normal — a live audit of the served catalogue
 * puts real configs at 1-3 visible matches. Anything past this is not a promo
 * box under any reading. */
const CARAMEL_MAX_COUPON_ANCHORS = 8

/* Visible elements a coupon selector resolves to, or [] if the selector is so
 * broad it cannot be describing a coupon control.
 *
 * Checkout detection asks "is a way to enter a code visible here?". A config
 * whose showInput contains a clause like `button:has(> *)` answers yes on
 * literally every page of the site — measured live on mejuri.com at 389 visible
 * matches on a category page, 48 on the homepage (QA sweep 2026-08-05). Today
 * that store is saved only by having no coupons in the database; the first code
 * scraped for it would put the prompt on every product and category page.
 *
 * Treating over-broad as NO match is the safe direction: a selector this loose
 * carries no information about where the promo box is, so acting on it means
 * guessing, and pickBestMatch's "first visible match in document order"
 * fallback would then be picking an arbitrary button on the page. Losing the
 * prompt on a misconfigured store costs a discount; keeping it costs the user a
 * prompt that follows them around the whole site and an apply flow aimed at
 * whatever element happened to sort first. */
export function caramelCouponAnchors(sel) {
    if (!sel) return []
    const visible = qAll(sel).filter(_isVisible)
    if (visible.length > CARAMEL_MAX_COUPON_ANCHORS) {
        log('CARAMEL_SELECTOR_TOO_BROAD', {
            sel: String(sel).slice(0, 120),
            visible: visible.length,
            max: CARAMEL_MAX_COUPON_ANCHORS,
        })
        return []
    }
    return visible
}

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export function pickBestMatch(sel, anchorEl) {
    const all = qAll(sel)
    if (!all.length) return null
    if (anchorEl) {
        let best = null
        let bestDepth = Infinity
        let bestVisible = false
        for (const cand of all) {
            let p = cand.parentElement
            let d = 0
            while (p && d < 8) {
                if (p.contains(anchorEl)) {
                    const v = _isVisible(cand)
                    if (
                        d < bestDepth ||
                        (d === bestDepth && v && !bestVisible)
                    ) {
                        bestDepth = d
                        best = cand
                        bestVisible = v
                    }
                    break
                }
                p = p.parentElement
                d++
            }
        }
        if (best) return best
    }
    return all.find(_isVisible) || all[0]
}
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export function waitForElement(sel, timeout = 4000) {
    return new Promise((res, rej) => {
        if (qOne(sel)) return res('found-immediately')
        const mo = new MutationObserver(() => {
            if (qOne(sel)) {
                mo.disconnect()
                res('appeared')
            }
        })
        mo.observe(document.documentElement, { childList: true, subtree: true })
        setTimeout(() => {
            mo.disconnect()
            rej(`waitForElement timeout (${sel})`)
        }, timeout)
    })
}
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export function waitForTextChange(el, timeout = 3000) {
    return new Promise((res, rej) => {
        const start = el.textContent
        const mo = new MutationObserver(() => {
            if (el.textContent !== start) {
                mo.disconnect()
                res('text-changed')
            }
        })
        mo.observe(el, { characterData: true, childList: true, subtree: true })
        setTimeout(() => {
            mo.disconnect()
            rej('waitForTextChange timeout')
        }, timeout)
    })
}
/* ---------- UI readiness helper ---------- */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export async function waitUntilReady(rec, timeout = 2000) {
    const btn = qOne(rec.couponSubmit)
    const start = performance.now()
    return new Promise(resolve => {
        ;(function loop() {
            if (!btn || !btn.disabled) return resolve()
            if (performance.now() - start > timeout) return resolve() // hard fallback
            requestAnimationFrame(loop)
        })()
    })
}

/* --------------------------------------------------  price grabber
 *
 * Money on a page, in the shapes the world actually writes it.
 *
 * The old reader required one of $ £ € IMMEDIATELY BEFORE the digits, and then
 * parsed by stripping everything except [0-9.]. That reads the United States,
 * the UK, and nowhere else. Measured against live storefronts during the QA
 * sweep (2026-08-05/06):
 *
 *   "Zwischensumme: 565.89 ت"  motoin.de      → no match, "getPrice: no price
 *                                               found" on a real €565 basket
 *   "AED 949.00"               mango.com/ae   → no match
 *   "DT 445.00 → DT 356.00"    rag-bone.com   → no match; a genuine 20% win
 *                                               was applied and the shopper was
 *                                               never told the number
 *   "3,49 €"                   rosegal.com    → no match
 *   "1.234,56 €"               German         → also MIS-PARSED to 1.234 by the
 *                                               old strip — a 1000x understatement
 *
 * Every continental-European locale writes the symbol after the number with a
 * comma decimal, so the product's headline feature — "you saved X" — silently
 * degraded to "review the discount before you check out" across all of them.
 *
 * A currency MARKER is still required (before or after), so a bare "2" from
 * "Qty 2" or a size can never be read as money. Letter codes must be uppercase
 * (USD, AED, CHF, DT, RM) or one of the few well-known lowercase/other-script
 * ones — that is what keeps "Save 10" and "Total 5" from parsing as prices.
 */
const CARAMEL_CURRENCY_SYMBOLS = '$£€¥₹₩₪₺₽฿₫₴₦₱﷼¢ت'
// Lowercase or non-Latin markers common enough to be worth naming explicitly.
// Uppercase codes are matched by shape instead (see the pattern below).
const CARAMEL_CURRENCY_WORDS = ['kr', 'zł', 'Kč', 'Ft', 'lei', 'zt', 'руб']
const _caramelMarkerAlt = [
    `[${CARAMEL_CURRENCY_SYMBOLS}]`,
    String.raw`\b[A-Z]{2,4}\$?`, // USD, AED, CHF, DT, RM, CA$, R$
    CARAMEL_CURRENCY_WORDS.map(w =>
        w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('|'),
].join('|')
// Digits with either grouping convention: 1,234.56 / 1.234,56 / 1 234,56.
const _caramelNumberPart = String.raw`\d{1,3}(?:[.,   ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const _caramelMoneyRe = new RegExp(
    `(?:(${_caramelMarkerAlt})\\s?(${_caramelNumberPart}))|(?:(${_caramelNumberPart})\\s?(${_caramelMarkerAlt}))`,
    'g',
)

/* Turn one matched number string into a Number, working out which separator is
 * the decimal one. Both conventions appear on real carts and guessing wrong is
 * a factor-of-1000 error in the direction of understating a saving.
 *   both separators → the LAST one is the decimal ("1.234,56", "1,234.56")
 *   one separator, 3 trailing digits → thousands ("1.234" = 1234, "1,234" = 1234)
 *   one separator, 1-2 trailing digits → decimal ("89,99", "356.00")
 */
// Consumed by the matcher below and pinned directly by tests.
export function caramelParseMoneyNumber(raw) {
    if (typeof raw !== 'string') return NaN
    const text = raw.replace(/[   ]/g, '')
    const lastDot = text.lastIndexOf('.')
    const lastComma = text.lastIndexOf(',')
    let decimalAt = -1
    if (lastDot >= 0 && lastComma >= 0) {
        decimalAt = Math.max(lastDot, lastComma)
    } else if (lastDot >= 0 || lastComma >= 0) {
        const only = Math.max(lastDot, lastComma)
        if (text.length - only - 1 !== 3) decimalAt = only
    }
    const digitsOnly = s => s.replace(/\D/g, '')
    const whole =
        decimalAt >= 0 ? digitsOnly(text.slice(0, decimalAt)) : digitsOnly(text)
    const frac = decimalAt >= 0 ? digitsOnly(text.slice(decimalAt + 1)) : ''
    if (!whole && !frac) return NaN
    return Number(`${whole || '0'}.${frac || '0'}`)
}

/* Every money amount in a block of text, newest-first order preserved, as
 * { value, marker }. The marker is whatever currency mark sat with it. */
// Consumed by getPrice; pinned directly by tests.
export function caramelFindMoney(text) {
    if (typeof text !== 'string' || !text) return []
    const out = []
    _caramelMoneyRe.lastIndex = 0
    let m
    while ((m = _caramelMoneyRe.exec(text)) !== null) {
        const marker = m[1] || m[4] || ''
        const number = m[2] || m[3] || ''
        const value = caramelParseMoneyNumber(number)
        if (!isNaN(value)) out.push({ value, marker })
    }
    return out
}

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export function getPrice(selector, { returnLargest } = {}) {
    let el = qOne(selector)
    if (!el && typeof selector === 'string' && selector.includes('[id=')) {
        const id = selector.match(/\[id=['"]([^'"]+)['"]\]/)?.[1]
        if (id) el = document.getElementById(id)
    }
    if (!el) {
        log('getPrice: element NOT found', selector)
        return NaN
    }

    const tokens = caramelFindMoney(el.innerText)
    const prices = tokens.map(t => t.value)
    if (!prices.length) {
        log('getPrice: no price found')
        return NaN
    }
    if (returnLargest) _caramelLastPrices = prices.slice()
    const idx = returnLargest ? prices.indexOf(Math.max(...prices)) : 0
    // Remember the marker that came with the price we actually returned, so
    // the savings we report back are denominated in the SAME currency the
    // cart is priced in. Reporting "$8.00" for an £8.00 saving is a bug the
    // user can see, and a config can't be trusted to tell us the currency.
    if (tokens[idx].marker) _caramelLastCurrency = tokens[idx].marker
    return prices[idx]
}

// Guarded `var` (re-injection convention). Defaults to '$' until a real
// price has been read.
if (typeof _caramelLastCurrency === 'undefined') {
    var _caramelLastCurrency = '$'
}

// EVERY price parsed out of the container on the last returnLargest read, not
// just the winner. A checkout panel routinely shows several ($42.00 total, a
// "$500 off" banner, an MSRP strikethrough) and the config can't tell us which
// is the order total — so the caller keeps the full set and picks the most
// conservative baseline it can defend. See caramelBaselineFor().
if (typeof _caramelLastPrices === 'undefined') {
    var _caramelLastPrices = []
}
// Read directly by coupon-apply.js (:469, :638) and coupon-runner.js (:757),
// which snapshot `.slice()` of it either side of an apply. Only this module
// ever writes it, so the live binding an importer gets is always the set
// getPrice last parsed. (global-map.json misses this one: its regex looks for
// column-0 declarations and this `var` sits inside the re-injection guard.)
export { _caramelLastPrices }

/* The tightest cart baseline consistent with an observed post-discount total:
 * the SMALLEST price seen in the container that is still >= `newTotal`.
 *
 * Taking the LARGEST number (what getPrice must do to find an order total) is
 * what lets a stray "$500 off" banner masquerade as the cart's original price
 * and turn a real $4.20 discount into a $462.20 headline. Choosing the smallest
 * candidate at or above the new total can never OVERSTATE a saving: any larger
 * candidate would have to be a number the discount didn't actually come off.
 *
 * Returns NaN when nothing qualifies (e.g. the total went UP) — the caller then
 * claims no figure at all. */
export function caramelBaselineFor(newTotal, prices = _caramelLastPrices) {
    if (typeof newTotal !== 'number' || isNaN(newTotal)) return NaN
    const candidates = (prices || []).filter(p => !isNaN(p) && p >= newTotal)
    return candidates.length ? Math.min(...candidates) : NaN
}
// Consumed by UI-helpers.js when rendering a measured saving.
export function caramelCurrencySymbol() {
    return _caramelLastCurrency || '$'
}

/* ISO code for the symbol we actually parsed off the page, for the savings
 * HISTORY. The modal renders the symbol, but the popup totals the history per
 * currency through Intl.NumberFormat (popup.js:81-98), which needs a code —
 * and banking every DOM-path win as 'USD' silently added £ and € savings into
 * the dollar bucket, overstating a non-US user's lifetime total.
 * '$' stays USD: a bare dollar sign can't distinguish USD/CAD/AUD, and USD is
 * the safest reading of an unqualified '$'. The discount-link path doesn't use
 * this — /cart.js hands it a real ISO code. */
// Consumed by coupon-runner.js (cross-file content-script call).
export function caramelCurrencyCode() {
    const marker = _caramelLastCurrency
    const mapped = { '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' }[marker]
    if (mapped) return mapped
    // A marker the page wrote as letters IS the code the store uses (AED, CHF,
    // DT). Pass it through rather than banking it as dollars: the popup totals
    // per currency and falls back to "89.00 DT" for anything Intl can't format,
    // which is honest, where calling it USD would not be.
    if (typeof marker === 'string' && /^[A-Z]{2,4}$/.test(marker)) return marker
    return 'USD'
}

/* Set the symbol explicitly when the currency is known from data rather than
 * from a price we just parsed — the post-reload handoff (store-detect.js)
 * restores a saving recorded BEFORE the reload, so no price has been read in
 * this page yet and the parsed value would still be the '$' default. */
export function caramelSetCurrencySymbol(sym) {
    if (typeof sym === 'string' && /^[$£€]$/.test(sym)) {
        _caramelLastCurrency = sym
        return true
    }
    return false
}

/* --------------------------------------------------  disclosure reveal
 *
 * The control that would reveal a promo box the shopper cannot currently see,
 * found from the box itself rather than from a per-store selector.
 *
 * "Visible" is the right test for whether to offer help — themes ship dead
 * coupon markup on pages that have no checkout. But it conflates two very
 * different situations: markup that is hidden because it is inert, and markup
 * hidden behind a disclosure the shopper can open in one tap. The QA sweep on
 * 2026-08-05 measured what the second costs:
 *
 *   - allbirds.com on a phone: Shopify collapses the order summary into a bar,
 *     and the discount field lives inside it. 30s on the cart drawer and 30s at
 *     checkout produced nothing; expanding the summary produced the prompt
 *     within the same second. An A/B/A across three reloads (1440 shows, 390
 *     doesn't, 1440 shows) confirmed it, and 900/700/500 were silent too — so
 *     this is small laptops and split screens as well as phones.
 *   - allposters.com at 1440: promo box behind "+ Add a Promo Code". Same
 *     signature — in the DOM, not visible, no prompt for 25s, prompt the moment
 *     the section was opened.
 *
 * Configs can already name that toggle (`showInput`), and stores that carry one
 * work fine; most simply never got one. This finds the toggle generically, from
 * the standard disclosure vocabulary, and is deliberately narrow: the control
 * must govern an ANCESTOR of the coupon input the config itself names, must be
 * visible, must not already be expanded, and must pass the order-button guard.
 * When nothing matches it returns null and behaviour is exactly as before.
 */
const CARAMEL_MAX_DISCLOSURE_DEPTH = 6
// Consumed by store-detect.js and coupon-runner.js (cross-file calls).
export function caramelDisclosureFor(el) {
    // Only ever for a box the shopper CAN'T see. A visible box needs no reveal.
    if (!el || _isVisible(el)) return null
    const usable = c =>
        c &&
        _isVisible(c) &&
        c.getAttribute?.('aria-expanded') !== 'true' &&
        !caramelIsForbiddenControl(c)
    let node = el
    for (let up = 0; up < CARAMEL_MAX_DISCLOSURE_DEPTH && node; up++) {
        node = node.parentElement
        if (!node) break
        // Native disclosure: <details> closed, <summary> opens it.
        if (node.tagName === 'DETAILS' && !node.open) {
            const summary = node.querySelector('summary')
            if (usable(summary)) return summary
        }
        // ARIA disclosure: some control elsewhere on the page names this
        // container in aria-controls. That is the pattern both measured stores
        // use, and it is how a screen-reader user finds the same toggle.
        if (node.id) {
            let controllers = []
            try {
                const id =
                    typeof CSS !== 'undefined' && CSS.escape
                        ? CSS.escape(node.id)
                        : node.id
                controllers = Array.from(
                    document.querySelectorAll(`[aria-controls="${id}"]`),
                )
            } catch {
                /* an id we can't express as a selector — try the next ancestor */
            }
            const toggle = controllers.find(usable)
            if (toggle) return toggle
        }
    }
    return null
}

/* --------------------------------------------------  navigation handoff
 *
 * Submitting a promo code on a classic (non-SPA) checkout is a form POST: the
 * page navigates, the content script and every overlay it drew are destroyed
 * mid-attempt, and everything the run knew dies with them. Measured on
 * 1800petmeds.com (QA sweep 2026-08-05): THEO20 took a real $14.78 off the
 * order and the user was told NOTHING for the ~180s they sat there — the fresh
 * document just re-inserted the "Try Caramel Coupons" pill, as if the extension
 * had never run. A win we actually delivered read as a dead feature.
 *
 * The discount-link path already survives its own (deliberate) reload through
 * sessionStorage; this is the same handoff for the path that navigates without
 * being asked. The crucial difference: this record carries only what we KNEW
 * BEFORE submitting — the code, its id, and the prices then on the page — and
 * never an outcome. At write time we genuinely do not know whether the code
 * landed, so the next document measures that for itself
 * (store-detect.js:_resumePendingSubmit). A record that guessed would put a
 * fabricated saving in the user's history.
 *
 * These live here, in the leaf, rather than beside the apply loop: the writer
 * (coupon-runner.js) and the reader (store-detect.js) are different files, and
 * store-detect loads FIRST — sharing a key through a top-level const would
 * depend on load order that doesn't hold.
 *
 * sessionStorage, like the tried-codes set: per-tab and per-origin, so a
 * pending attempt can never surface on another site or in another tab, and it
 * dies with the tab.
 */
const CARAMEL_PENDING_KEY = 'caramel_pending_submit'
// Consumed by coupon-runner.js (cross-file content-script call).
export function caramelMarkPendingSubmit(code, id, prices) {
    try {
        sessionStorage.setItem(
            CARAMEL_PENDING_KEY,
            JSON.stringify({
                code,
                id: id ?? null,
                prices: (prices || []).filter(
                    p => typeof p === 'number' && !isNaN(p),
                ),
                t: Date.now(),
            }),
        )
    } catch {
        /* storage blocked — we lose only the post-navigation report */
    }
}
// Consumed by coupon-runner.js (cross-file content-script call).
export function caramelClearPendingSubmit() {
    try {
        sessionStorage.removeItem(CARAMEL_PENDING_KEY)
    } catch {
        /* storage blocked — the freshness window bounds the damage */
    }
}
/* Reads AND consumes the record: a pending attempt is reported once, on the
 * document that follows it, or not at all. Returns null when there is nothing
 * to resume or the record is stale/unreadable. */
// Consumed by store-detect.js (cross-file content-script call).
export function caramelTakePendingSubmit(maxAgeMs = 120000) {
    let raw = null
    try {
        raw = sessionStorage.getItem(CARAMEL_PENDING_KEY)
        if (raw) sessionStorage.removeItem(CARAMEL_PENDING_KEY)
    } catch {
        return null
    }
    if (!raw) return null
    let st = null
    try {
        st = JSON.parse(raw)
    } catch {
        return null
    }
    if (!st || typeof st.code !== 'string' || !st.code) return null
    // A record older than the window belongs to a visit the user has moved on
    // from; announcing it over an unrelated page would be noise, not news.
    if (!(Date.now() - (st.t || 0) < maxAgeMs)) return null
    return {
        code: st.code,
        id: st.id ?? null,
        prices: Array.isArray(st.prices) ? st.prices : [],
    }
}

/* --------------------------------------------------  run continuity
 *
 * One click should test more than one code.
 *
 * On a classic form-POST cart, submitting a promo code is a full page load, so
 * exactly ONE code gets tried per click and the shopper has to press the pill
 * again for the next one. motoin.de and proaudiostar.com both work this way:
 * with 20 codes in the list that is 20 clicks and 20 page reloads, each one
 * ~10 seconds, to do what takes a single click on a Shopify cart. Nobody
 * finishes that. The codes at the bottom of the list are effectively unreachable
 * — which is where the untried ones are, because the sink puts them there.
 *
 * The record below carries a run across those navigations so the loop picks
 * itself up on the new page. It is deliberately small and strictly bounded, and
 * every bound exists to answer the same question: this submits real codes to a
 * real merchant without the shopper clicking again, so what stops it?
 *
 *   · it only ever exists because the shopper clicked — nothing else writes it
 *   · CARAMEL_RUN_MAX_HOPS caps how many navigations one click may cause
 *   · CARAMEL_RUN_MAX_AGE_MS caps the whole chain in wall-clock time
 *   · each hop consumes at least one code from the tried-set, which also
 *     survives the navigation, so a chain cannot revisit the same code
 *   · cancelling (× or Esc) writes the flag that ends it, because
 *     _caramelCancelled itself does not survive a page load
 *   · the caller additionally refuses to continue on a page with no coupon box
 *
 * sessionStorage for the same reasons as the pending-submit record above:
 * per-tab, per-origin, and it dies with the tab.
 */
const CARAMEL_RUN_KEY = 'caramel_run'
const CARAMEL_RUN_MAX_HOPS = 6
const CARAMEL_RUN_MAX_AGE_MS = 180000
// Consumed by coupon-runner.js (cross-file content-script call).
export function caramelBeginRun() {
    try {
        const raw = sessionStorage.getItem(CARAMEL_RUN_KEY)
        if (raw) {
            /* A run already in flight — this is a hop of it, not a new one, so
             * the hop count and the clock carry on.
             *
             * Unless it was CANCELLED. That record is a tombstone: hops pinned
             * at the cap so no continuation can claim one. Treating it as "in
             * flight" would let a single × silence continuation for the rest of
             * the tab — the shopper presses the pill again, deliberately, and
             * gets the one-code-per-reload behaviour back with no way to
             * recover short of closing the tab. Pressing the pill IS the
             * consent this whole mechanism runs on, so it starts a fresh run. */
            let cancelled = false
            try {
                cancelled = !!JSON.parse(raw)?.cancelled
            } catch {
                // Unreadable record: not something to build a chain on either.
                cancelled = true
            }
            if (!cancelled) return
        }
        sessionStorage.setItem(
            CARAMEL_RUN_KEY,
            JSON.stringify({ hops: 0, t: Date.now() }),
        )
    } catch {
        /* storage blocked — the run simply won't continue past a navigation */
    }
}
// Consumed by store-detect.js + UI-helpers.js (cross-file content-script call).
export function caramelEndRun() {
    try {
        sessionStorage.removeItem(CARAMEL_RUN_KEY)
    } catch {
        /* storage blocked — the hop and age caps still bound the chain */
    }
}
/* Claims the next hop of an in-flight run, or returns null if there isn't one
 * to claim. Writing the increment here (rather than at the call site) is what
 * makes the cap hold even if a caller returns early afterwards. */
// Consumed by store-detect.js (cross-file content-script call).
export function caramelClaimRunHop() {
    let raw = null
    try {
        raw = sessionStorage.getItem(CARAMEL_RUN_KEY)
    } catch {
        return null
    }
    if (!raw) return null
    let run = null
    try {
        run = JSON.parse(raw)
    } catch {
        caramelEndRun()
        return null
    }
    if (!run || run.cancelled) {
        caramelEndRun()
        return null
    }
    const hops = Number(run.hops) || 0
    const startedAt = Number(run.t) || 0
    if (hops >= CARAMEL_RUN_MAX_HOPS) {
        caramelEndRun()
        return null
    }
    if (!(Date.now() - startedAt < CARAMEL_RUN_MAX_AGE_MS)) {
        caramelEndRun()
        return null
    }
    try {
        sessionStorage.setItem(
            CARAMEL_RUN_KEY,
            JSON.stringify({ hops: hops + 1, t: startedAt }),
        )
    } catch {
        return null
    }
    return { hops: hops + 1, remaining: CARAMEL_RUN_MAX_HOPS - (hops + 1) }
}
/* The × and Esc set _caramelCancelled, which dies with the document. A chain
 * spans documents, so "stop" has to be written down. */
// Consumed by UI-helpers.js (cross-file content-script call).
export function caramelCancelRun() {
    try {
        if (!sessionStorage.getItem(CARAMEL_RUN_KEY)) return
        sessionStorage.setItem(
            CARAMEL_RUN_KEY,
            JSON.stringify({ hops: CARAMEL_RUN_MAX_HOPS, t: 0, cancelled: 1 }),
        )
    } catch {
        /* storage blocked — the caps remain the backstop */
    }
}

/* --------------------------------------------------  selector helper
 * Configs may store either a CSS selector or an XPath expression. The agent
 * picks whichever uniquely identifies the element on each store. Detect by
 * leading char and dispatch to the right DOM API.
 *   "input#code"           → CSS  → querySelector
 *   "//input[@id='code']"  → XPath → document.evaluate
 *   "(//div)[2]"           → XPath
 */
// Exported for tests/shared-utils.test.mjs, which characterizes it directly.
export function _isXPath(sel) {
    if (typeof sel !== 'string' || !sel) return false
    const t = sel.trim()
    return t.startsWith('/') || t.startsWith('(/') || t.startsWith('./')
}
export function qOne(sel, root) {
    if (!sel) return null
    root = root || document
    try {
        if (_isXPath(sel)) {
            const res = document.evaluate(
                sel,
                root,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
            )
            return res.singleNodeValue
        }
        return root.querySelector(sel)
    } catch {
        return null
    }
}
export function qAll(sel, root) {
    if (!sel) return []
    root = root || document
    try {
        if (_isXPath(sel)) {
            const res = document.evaluate(
                sel,
                root,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
            )
            const out = []
            for (let i = 0; i < res.snapshotLength; i++)
                out.push(res.snapshotItem(i))
            return out
        }
        return Array.from(root.querySelectorAll(sel))
    } catch {
        return []
    }
}
