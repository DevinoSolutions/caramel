// owns: coupon-apply engine — generic selectors, input/error detection, applyCoupon, discount-link fallback (GENERIC_* selectors, setInputValue, removeAppliedCoupon, detectCouponError, applyCoupon, probeCartJson, applyViaDiscountLink)
// load after: caramel-base.js, dom-utils.js, store-detect.js

// ES module since the WXT P1 port (2026-08-12). Same statements in the same
// order; the only new plumbing is explicit imports for the symbols this file
// used to read off the shared script realm, and `export` on the ones
// coupon-runner.js / store-detect.js call. This file publishes nothing on
// window/globalThis and has no effectful top-level statement, so it exports no
// init() — there is nothing for the composition entrypoint to call.
import { log, logError, recordTiming, sleep } from './caramel-base.js'
import { caramelLoadedFinder } from './coupon-box-finder-loader.js'
import {
    _caramelLastPrices,
    _isVisible,
    caramelDisclosureFor,
    caramelFormSubmitIsUnsafe,
    caramelIsForbiddenControl,
    caramelSubmitBesideInput,
    getPrice,
    pickBestMatch,
    qAll,
    qOne,
    waitForTotalChange,
    waitForVisible,
} from './dom-utils.js'

// A record the finder built (rec.caramelFound) exists only once the finder is
// loaded (coupon-box-finder-loader.js), so these always reach it. Should it
// ever be missing, the total reads as unknown and nothing is re-marked: no
// saving can be measured from that.
const caramelFinderTotalNow = (...args) =>
    caramelLoadedFinder()?.caramelFinderTotalNow(...args) ?? NaN
const caramelRemarkFoundBox = (...args) =>
    caramelLoadedFinder()?.caramelRemarkFoundBox(...args) ?? false

// Generic selectors used when the per-store config doesn't specify them.
// These cover the most common Honey-style cart UIs.
const GENERIC_APPLIED_SELECTORS =
    '[class*="coupon-applied" i], [class*="discount-applied" i], ' +
    '[class*="cart-coupon-list" i] li, [class*="applied-coupon" i], ' +
    '[class*="coupon-list-item" i], [class*="redeemed" i]'
// Remove-button fallbacks, in DESCENDING order of confidence. Kept as two
// tiers rather than one comma-joined selector on purpose: a single selector is
// resolved in DOCUMENT order, so a vague match could outrank a precise one just
// by sitting lower on the page.
//
// Tier 1 is self-scoping — every selector names a coupon container, so a match
// is a coupon remove button by construction.
const GENERIC_REMOVE_SELECTORS_SCOPED =
    '[class*="cart-coupon-list" i] li button, [class*="coupon-list-item" i] button, ' +
    '[class*="applied-coupon" i] button'
// There is deliberately NO unscoped tier. It used to exist —
//   [aria-label*="Remove" i], [aria-label*="Delete" i], button[title*="Remove" i]
// — naming no coupon context whatsoever, so on a cart page it matched line-item
// remove buttons just as well as a coupon's. Since removeAppliedCoupon runs
// BETWEEN failed codes (up to 8x a run) on every store that doesn't set
// `couponRemove`, a wrong pick there silently empties the user's cart.
//
// Two proximity guards were tried and MEASURED, both failed: walking up from the
// button reaches <body> on a shallow cart, and walking up from the input reaches
// the shared summary container. Neither separates the two, because a line item's
// bare "Remove" and a coupon's bare "Remove" are genuinely identical in DOM
// shape and label. A text deny-list catches "Remove item" but not a bare
// "Remove".
//
// So the guess is gone rather than refined. When nothing coupon-scoped matches,
// removeAppliedCoupon falls through to clearing the input — the cost is a
// coupon that may stack on the next attempt (a missed discount), instead of a
// deleted cart. If a store genuinely needs a remove button we can't scope, that
// belongs in its config's `couponRemove`, where it is a deliberate per-store
// decision rather than a blind default for every store.
export const GENERIC_ERROR_TEXT_RE =
    /\b(invalid|expired|not\s+(valid|applicable|eligible)|limited\s+to|cannot\s+be\s+(applied|redeemed)|doesn'?t\s+apply|no\s+eligible|enter\s+a\s+valid|nicht|ungültig|abgelaufen|expiré|expirado|caducado)\b/i
// `abgelaufen` / `expiré` / `expirado` / `caducado` are the same word as
// "expired" in the four European languages our catalogue actually covers, and
// each one is unambiguous — unlike the bare `nicht` above, they cannot appear in
// ordinary storefront copy without meaning that something has run out. Added
// when motoin.de's own expiry banner turned out to be unreadable to us
// (tests/post-navigation-verdict.test.mjs).

export function findAppliedSelector(rec) {
    return rec.successIndicator || GENERIC_APPLIED_SELECTORS
}

/* A row matching the applied-coupon selector that says, in words, that the
 * coupon was NOT applied.
 *
 * The success test is "a new row appeared where applied coupons live". On
 * allposters.com (QA sweep 2026-08-05) the rows that appeared read
 * "25% Off Everything*  Not Applied ✕" — the checkout's own rejection notice,
 * rendered inside the very container applied coupons use. We counted two of
 * them as two successes and told the shopper "✓ Coupon Applied / Discount
 * visible in your cart" over a total that had not moved by a cent, with the
 * store's red "Not Applied" printed beside our modal.
 *
 * So read the row before believing it. This only ever REMOVES a success
 * signal, never invents one: a row that says nothing is still counted, exactly
 * as before.
 *
 * The Gap Inc. checkout (gap, gapfactory, oldnavy, bananarepublic, athleta)
 * lists ANY code it was given under "Applied Promos", including one that saves
 * nothing: "CARAMELTEST1 $0.00 No items in your bag qualify." (gap.com, live
 * 2026-10-26). "Some items don't qualify" is left alone: that code did apply. */
const CARAMEL_REJECTED_ROW_RE = new RegExp(
    String.raw`\bnot\s+applied\b|\bnicht\s+angewendet\b|\bnon\s+appliqué|\bno\s+(?:items?|products?)\b[^.]{0,40}?\bqualif(?:y|ies)\b`,
    'i',
)
export function caramelRowReadsRejected(el) {
    if (!el) return false
    const text = (el.innerText || el.textContent || '').trim().slice(0, 300)
    if (!text) return false
    return (
        CARAMEL_REJECTED_ROW_RE.test(text) || GENERIC_ERROR_TEXT_RE.test(text)
    )
}
/* Applied-coupon rows that don't declare themselves rejected. Used for BOTH
 * the before and after counts, so the comparison stays like-for-like. */
// Also read directly by tests/false-success.test.mjs.
export function caramelAcceptedRowCount(sel) {
    return qAll(sel).filter(el => !caramelRowReadsRejected(el)).length
}
function findRemoveSelector(rec) {
    return rec.couponRemove || GENERIC_REMOVE_SELECTORS_SCOPED
}

// Set value on a (possibly React-controlled) input + fire input/change events.
export function setInputValue(input, code) {
    const proto = window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(input, code)
    else input.value = code
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

/* The text a remove button sits in — its own row, not the whole cart. Used
 * only to tell OUR coupon's remove button apart from someone else's. */
function _caramelRemoveRowText(btn) {
    let node = btn
    for (let up = 0; up < 3 && node; up++) {
        node = node.parentElement
        const text = (node?.innerText || node?.textContent || '').trim()
        if (text) return text.toUpperCase().slice(0, 400)
    }
    return ''
}

/* A product line in the cart, by the markup the common platforms give it:
 * Shopify's <cart-remove-button> and data-line-item keys, BigCommerce's
 * data-cart-itemid, WooCommerce's tr.cart_item, and the usual class names. */
const CARAMEL_CART_LINE_SEL =
    'cart-remove-button, [data-cart-item], [data-cart-itemid], [data-cart-item-key], [data-line-item], [data-line-item-key], .cart-item, .cart__item, .cart-line-item, tr.cart__row, tr.cart_item, .woocommerce-cart-form__cart-item'
/* A field that changes how many of a product are in the cart. Only a product
 * line carries one; a discount row never does. */
const CARAMEL_LINE_QTY_SEL =
    'input[name*="quantity" i], input[name^="updates"], select[name*="quantity" i], [data-quantity-input]'

/* Does this remove button belong to a product line rather than to a discount?
 * Its label cannot say: Shopify labels a line's button "Remove <product name>",
 * which the forbidden-control guard does not read as a cart change, and a line
 * that carries a line-level discount even shows our code in its text. So look
 * at where it sits: inside a known line container, or a few levels under an
 * ancestor holding exactly ONE quantity field. The climb stops as soon as the
 * ancestor holds another candidate, the coupon box, or several quantity
 * fields: past that point we are in the container shared by every line and the
 * discount row, and a quantity field there says nothing about this button. */
function _caramelInCartLine(btn, candidates, couponInput) {
    try {
        if (btn.closest?.(CARAMEL_CART_LINE_SEL)) return true
        let node = btn.parentElement
        for (let up = 0; up < 4 && node; up++) {
            if (candidates.some(c => c !== btn && node.contains(c))) break
            if (couponInput && node.contains(couponInput)) break
            const qty = node.querySelectorAll(CARAMEL_LINE_QTY_SEL).length
            if (qty > 1) break
            if (qty === 1) return true
            node = node.parentElement
        }
    } catch {
        // An unreadable ancestor chain is not evidence the button is safe.
        return true
    }
    return false
}

/* The "are you sure?" step some carts put between the remove button and the
 * removal. Salesforce Commerce Cloud (SFRA) carts open #removeCouponModal
 * ("Remove Coupon? ... Yes / No") and remove the code only on its Yes
 * (aquasana.com 2026-10-27): our click stopped at the dialog, the refused code
 * stayed on the cart, and the next code was refused as "cannot be combined
 * with other coupons already in your cart" (T-9569).
 *
 * Only the dialog the remove button itself names (data-target,
 * data-bs-target, aria-controls), only while it is visible, only when it talks
 * about a coupon, and only its confirm button. Returns whether it clicked. */
const CARAMEL_REMOVE_DIALOG_TOPIC_RE = /coupon|promo|code|discount|voucher/i
const CARAMEL_REMOVE_CONFIRM_TEXT_RE = /^(?:yes|remove|confirm|delete|ok)\b/i
async function _caramelConfirmRemoveDialog(removeBtn) {
    const named =
        removeBtn.getAttribute('data-target') ||
        removeBtn.getAttribute('data-bs-target') ||
        (removeBtn.getAttribute('aria-controls')
            ? '#' + removeBtn.getAttribute('aria-controls')
            : '')
    if (!named || !named.startsWith('#')) return false
    const dialog = document.getElementById(named.slice(1))
    if (!dialog) return false
    // Bootstrap fades its backdrop in first and only then shows the dialog.
    const openedBy = performance.now() + 2000
    while (!_isVisible(dialog) && performance.now() < openedBy) await sleep(100)
    if (!_isVisible(dialog)) {
        log('REMOVE_DIALOG_NEVER_OPENED', { dialog: named })
        return false
    }
    // Bootstrap ignores a hide asked for while the dialog is still fading in:
    // a Yes clicked mid-fade removed the code but left the dialog open over
    // the cart, and the next code's × then toggled it shut instead of opening
    // it, so every other refused code stayed on the cart (aquasana.com,
    // 2026-10-27). Let the fade finish first.
    const settledBy = performance.now() + 1500
    while (_caramelIsAnimating(dialog) && performance.now() < settledBy)
        await sleep(50)
    if (
        !CARAMEL_REMOVE_DIALOG_TOPIC_RE.test(
            dialog.innerText || dialog.textContent || '',
        )
    )
        return false
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(
        b => _isVisible(b) && !b.disabled && !caramelIsForbiddenControl(b),
    )
    const confirm =
        buttons.find(b =>
            b.classList.contains('delete-coupon-confirmation-btn'),
        ) ||
        buttons.find(b =>
            CARAMEL_REMOVE_CONFIRM_TEXT_RE.test(
                (b.innerText || b.textContent || '').trim(),
            ),
        )
    if (!confirm) return false
    confirm.click()
    const closedBy = performance.now() + 3000
    do await sleep(100)
    while (_isVisible(dialog) && performance.now() < closedBy)
    log(
        _isVisible(dialog)
            ? 'REMOVE_DIALOG_LEFT_OPEN'
            : 'REMOVE_CONFIRMED_IN_DIALOG',
        { dialog: named },
    )
    return true
}

// A running CSS transition or animation on the element or inside it.
function _caramelIsAnimating(el) {
    return (
        typeof el.getAnimations === 'function' &&
        el.getAnimations({ subtree: true }).some(a => a.playState === 'running')
    )
}

/* Try to remove the coupon WE just applied. Returns true if a remove button was
 * clicked. Caller should wait for the cart to update.
 *
 * `options.code` is the code this cleanup is for, and `options.hadPreExisting`
 * says whether the cart already showed an applied discount before our run
 * started. Both exist because of the same defect: this function used to click
 * the LAST visible remove button, on the reasoning that the newest coupon
 * renders last. On a cart where the shopper had already applied their own code,
 * that reasoning is a coin flip — and losing it costs them real money on an
 * action they never asked for.
 *
 * So: remove the row that names our code. If we can't find it and there WAS a
 * discount on the cart before we arrived, remove nothing and say so. Leaving our
 * own failed code sitting there is a far cheaper mistake than stripping theirs.
 */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export async function removeAppliedCoupon(rec, options) {
    const ourCode = options?.code
        ? String(options.code).trim().toUpperCase()
        : null
    const hadPreExisting = !!options?.hadPreExisting
    // Prefer per-config remove; fall back to the coupon-SCOPED generics.
    const sel = findRemoveSelector(rec)
    const usable = b =>
        _isVisible(b) && !b.disabled && !caramelIsForbiddenControl(b)
    // qAll (not raw querySelectorAll) so an XPath couponRemove selector is
    // evaluated correctly instead of throwing a SyntaxError that aborts removal.
    const visible = qAll(sel).filter(usable)
    // A broad couponRemove ([aria-label*="Remove"] is on 865 served Shopify
    // configs) also matches every product line's own button. Clicking one
    // takes the product out of the shopper's cart, so those never count.
    const couponInput = qOne(rec.couponInput)
    const candidates = visible.filter(
        b => !_caramelInCartLine(b, visible, couponInput),
    )
    if (visible.length && !candidates.length) {
        log('REMOVE_REFUSED_CART_LINE', {
            code: ourCode,
            candidates: visible.length,
            reason: 'every remove button the selector found sits in a product line — clicking one would take a product out of the cart',
        })
        return false
    }
    if (candidates.length) {
        let btn = ourCode
            ? candidates.find(b =>
                  _caramelRemoveRowText(b).includes(ourCode),
              ) || null
            : null
        if (!btn && hadPreExisting) {
            log('REMOVE_REFUSED_NOT_OURS', {
                code: ourCode,
                candidates: candidates.length,
                reason: 'the cart already carried a discount when we arrived and no row names our code — removing one would take away the shopper’s own',
            })
            return false
        }
        // Nothing pre-existed, so anything applied here is ours. The newest
        // coupon is usually rendered last.
        if (!btn) btn = candidates[candidates.length - 1]
        btn.click()
        await sleep(600)
        await _caramelConfirmRemoveDialog(btn)
        log('Removed applied coupon via', sel)
        return true
    }
    log('removeAppliedCoupon: no coupon-scoped remove button — clearing input')
    // Last resort: clear the input. Some sites tie this to "remove".
    const input = qOne(rec.couponInput)
    if (input && input.value) {
        setInputValue(input, '')
        await sleep(300)
        log('Cleared input as remove fallback')
        return true
    }
    return false
}

// Detect if an error message appeared near the cart/coupon UI.
// Pick the first VISIBLE non-empty match across all elements that match the
// errorIndicator selector. Some Shopify themes (paragonsports, others) ship
// two `.alert.alert--error` elements: a hidden empty placeholder and a
// real one that fills with text. `qOne` would return the placeholder and
// miss the real error. Iterate so we always observe the live one.
function _firstVisibleErrorEl(rec) {
    if (!rec.errorIndicator) return null
    const all = qAll(rec.errorIndicator)
    for (const el of all) {
        if (!el || !_isVisible(el)) continue
        const t = (el.innerText || '').trim()
        if (t.length) return el
    }
    // No visible non-empty match — return the first match (so callers can
    // still observe "exists but hidden/empty" baseline state).
    return all[0] || null
}

function snapshotErrorState(rec) {
    // Capture the error region's text + visibility BEFORE we apply, so we can
    // tell whether an error appeared *because of this attempt* vs. a stale
    // error container that some sites keep mounted (aria-live regions,
    // placeholder error rows, etc.). Without this snapshot the extension
    // would treat permanently-mounted empty error containers as "error
    // present" and loop forever even after a valid coupon applied.
    if (!rec.errorIndicator) return { text: '', visible: false }
    const el = _firstVisibleErrorEl(rec)
    if (!el) return { text: '', visible: false }
    return {
        text: (el.innerText || '').trim(),
        visible: _isVisible(el),
    }
}

/* Everything the coupon area already said BEFORE we submitted anything.
 *
 * We show the shopper the store's own words — “The store said: …” — and that
 * sentence has to be TRUE. On mango.com/ae (QA sweep 2026-08-06) it wasn't: the
 * modal read “The store said: رمز ترويجي”, which is not a rejection at all. It
 * is the field's LABEL, "Promotional code", sitting above the box the whole
 * time. Putting a store's furniture in its mouth as a verdict is worse than
 * saying nothing, because the shopper has no way to tell the difference and
 * walks away believing the store refused them.
 *
 * 38 of our configs carry the bare `[class*="error"]` pattern, so this is not
 * one store's problem — any element the config happens to hit can be quoted.
 * The test that no static label can pass: it has to be text that was NOT on the
 * page a moment ago. Detection is unchanged (`errorMsg` still drives the
 * success rules and the no-signal early-exit) — only ATTRIBUTION is gated, so a
 * misfiring selector costs us a quote, never a wrong verdict.
 *
 * Both regions the detector reads are captured: every errorIndicator match, and
 * the ancestor chain around the input that the generic branch walks.
 */
// Also read directly by tests/store-said-attribution.test.mjs.
export function _caramelCouponAreaText(rec) {
    // innerText to match what the detector reads, textContent when there is no
    // innerText to read: `[class*="error"]` can land on an SVG or another
    // non-HTML node, where innerText is undefined and the snapshot would
    // silently remember nothing at all.
    const textOf = el => (el?.innerText ?? el?.textContent) || ''
    const parts = []
    if (rec?.errorIndicator) {
        for (const el of qAll(rec.errorIndicator)) parts.push(textOf(el))
    }
    let scope = pickBestMatch(rec?.couponInput)?.parentElement
    for (let d = 0; d < 5 && scope; d++) {
        parts.push(textOf(scope))
        scope = scope.parentElement
    }
    // Joined with a sentinel, not a space: two adjacent chunks must not be
    // able to form a phrase neither of them contained, or a store message
    // that straddles the boundary would read as text we had seen before and
    // get suppressed. A pilcrow survives the whitespace collapse below and,
    // unlike the NUL that sat here until 2026-08-06, leaves the file as text
    // its own repo's search tools will still open.
    return _caramelNormalizeQuote(parts.join(' ¶ '))
}

function _caramelNormalizeQuote(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
}

/* Is this quote the store's answer to US, or something it was already saying? */
// Called from other split content-script files, and read directly by
// tests/store-said-attribution.test.mjs.
export function caramelQuoteIsAttributable(quote, priorText) {
    const q = _caramelNormalizeQuote(quote)
    if (!q) return false
    return !_caramelNormalizeQuote(priorText).includes(q)
}

const ERROR_WORDS_RE =
    /\b(invalid|expired|not valid|doesn'?t apply|cannot be applied|cannot apply|already used|no longer|reached the limit|minimum|coupon code is required|wrong code)\b/i

// The text of every innermost SHOWN element under scope that carries a
// rejection phrase: the store's sentences, without the label or button around
// them. An element that also holds a control (a box whose own text is a hint
// beside its button) contributes its own words only, so a button relabelled
// "Applying…" never reads as the store answering.
const _CARAMEL_CONTROLS = 'button, input, select, textarea, a, [role="button"]'
// The words a store refuses a code in, for a box the finder picked: the
// vocabulary the client-side discovery lab proved across hundreds of stores and
// several languages ("not an active offer", "does not exist", "Der Gutschein
// ist abgelaufen"). A config's box keeps its own errorIndicator and the
// narrower GENERIC_ERROR_TEXT_RE. These words decide only when the wait for an
// answer ends and which sentence is quoted: a finder verdict is money only.
export const _CARAMEL_FINDER_NO_RE = new RegExp(
    GENERIC_ERROR_TEXT_RE.source +
        '|' +
        String.raw`(gib|geben sie) einen g[üu]ltigen (rabattcode|gutschein)|(saisissez|entrez|veuillez saisir) un code (de r[ée]duction |promo )?valide|(introduce|ingresa|introduzca|ingrese) un c[oó]digo (de descuento |promocional )?v[aá]lido|inserisci un codice (sconto |promozionale )?valido|voer een geldige (kortingscode|actiecode)|(insira|introduza|digite) um c[oó]digo (de desconto )?v[aá]lido|ange en giltig rabattkod|(angiv|indtast|oppgi|skriv inn) en gyldig rabatt?kode|wprowad[źz] prawid[łl]owy kod|(gutschein(code)?|rabattcode|aktionscode|promocode)\b[^.!]{0,80}\b(nicht (eingelöst|gültig|anwendbar|einlösbar)|ungültig|abgelaufen)|(code promo(tionnel)?|code de réduction|bon de réduction|coupon)\b[^.!]{0,60}\b(invalide|n.est pas valide|n.est plus valide|expiré|non valide)|(c[oó]digo (promocional|de descuento)|cup[oó]n)\b[^.!]{0,60}\b(no es v[aá]lido|no v[aá]lido|inv[aá]lido|caducado|ha expirado)|(kortingscode|actiecode|waardebon|cadeaubon)\b[^.!]{0,60}\b(ongeldig|niet geldig|verlopen)|(codice (sconto|promozionale|promo|coupon)|buono( sconto)?|coupon)\b[^.!]{0,80}\b(non (è|e'|e) valid[oa]|non valid[oa]|scadut[oa]|non applicabile|non esiste)|(c[oó]digo (promocional|de desconto)|cupom|cup[aã]o)\b[^.!]{0,60}\b(inv[aá]lido|n[aã]o (é )?v[aá]lido|expirado)|(kod (rabatowy|promocyjny)|kupon)\b[^.!]{0,60}\b(nieprawid[łl]owy|niewa[żz]ny|wygas[łl])|(rabattkod(en)?|kampanjkod(en)?|rabatkode(n)?|rabattkode(n)?)\b[^.!]{0,60}\b(ogiltig|inte giltig|ugyldig|er ikke gyldig|udl[øo]bet|utl[øo]pt)|not applied|wasn.t applied|isn.t applied|could not be applied|invalid|not valid|isn.t valid|is not a valid|not an? valid (discount |promo(tion(al)?)? |coupon |voucher |gift ?card |offer )?(code|coupon|voucher)|(code|coupon|discount|promo(tion)?|voucher|offer|gift ?card|reduction)\b[^.!]{0,60}\b(unable|couldn.t|could not|cannot|can not|can.t be)|\b(unable|couldn.t|could not|cannot|can not|can.t)\b[^.!]{0,60}\b(code|coupon|discount|promo|voucher|offer|gift ?card)|not an? (active|current) (offer|code|promo(tion)?|coupon|voucher)|not found|(code|coupon|promo|voucher)\b[^.!]{0,40}\bnot present\b|doesn.t exist|does not exist|not recogni[sz]ed|expired|enter a valid|not applicable|not eligible|(code|coupon|promo(tion)?|discount|voucher|offer)\b[^.!;,\u2013\u2014]{0,40}\b(is|was|are|were) (now )?ineligible|no longer (valid|active|available)|(code|coupon|promo|voucher)\b[^.!]{0,40}\b(incorrect|no longer|did(n.t| not) work)|incorrect (code|coupon|promo|voucher)|make sure (that )?(you have |you've |you )?(entered|typed) (the |a |your )?(correct|valid|right) (coupon |promo |discount |voucher )?code|does not apply|doesn.t apply|ung[üu]ltig|no es v[aá]lido|n.est pas valide|usage limit|reached its (usage )?limit|limit (has been |was )?reached|already (been )?(used|redeemed|applied to (an|another) order)|has been redeemed|one.time use`,
    'i',
)
// A form's own field error ("Enter a valid email address") is not the store's
// answer about a code, unless it also speaks about one.
const _CARAMEL_FIELD_RE =
    /\b(e-?mail|password|phone|zip|post ?code|postal|address|card number|cvv)\b/i
const _CARAMEL_COUPON_WORD_RE =
    /coupon|promo|discount|voucher|\boffers?\b|gift ?card/i
// "code" is a coupon word unless a form field's name sits right before it ("zip
// code", "security code"). Safari before 16.4 has no regex lookbehind, so the
// "unless" is a check on the text before each "code" instead of a pattern.
const _CARAMEL_CODE_WORD_RE = /\bcodes?\b/i
const _CARAMEL_FIELD_NAME_BEFORE_RE =
    /\b(zip|post(al)?|area|country|security|verification|sort|sms|access)\s?$/i
// True when `text` holds a match of `wordRe` that does not directly follow
// `blockerEndingRe` (a pattern anchored with `$` against the text before the
// match). The scan resumes one character after each match start, so
// overlapping occurrences are all weighed.
function _caramelHasWordNotAfter(text, wordRe, blockerEndingRe) {
    const scan = new RegExp(wordRe.source, 'gi')
    for (let m = scan.exec(text); m; m = scan.exec(text)) {
        if (!blockerEndingRe.test(text.slice(0, m.index))) return true
        scan.lastIndex = m.index + 1
    }
    return false
}
// "minimum" is a refusal word ("a minimum spend applies") unless it is "no
// minimum" ("no " starting at a word boundary, one space).
const _CARAMEL_NO_BEFORE_RE = /\bno $/i
function _caramelFinderNoPhrase(text) {
    return (
        _CARAMEL_FINDER_NO_RE.test(text) ||
        _caramelHasWordNotAfter(text, /minimum/, _CARAMEL_NO_BEFORE_RE)
    )
}
function _caramelNamesCoupon(text) {
    return (
        _CARAMEL_COUPON_WORD_RE.test(text) ||
        _caramelHasWordNotAfter(
            text,
            _CARAMEL_CODE_WORD_RE,
            _CARAMEL_FIELD_NAME_BEFORE_RE,
        )
    )
}
export function _caramelFinderSaysNo(text) {
    const t = text || ''
    return (
        _caramelFinderNoPhrase(t) &&
        !(_CARAMEL_FIELD_RE.test(t) && !_caramelNamesCoupon(t))
    )
}
// The store saying it took the code: a sentence about a code, not on the page
// before we submitted, that negates nothing and refuses nothing ("could not be
// applied", "already been redeemed" are refusals; "Item added" and "Free
// shipping applied" are about something else).
const _CARAMEL_ACCEPTED_RE =
    /\b(applied|added|activated|accepted|redeemed|success(ful(ly)?)?)\b/i
const _CARAMEL_NEGATION_RE =
    /\b(not|no|never|unable|cannot|invalid|(can|couldn|won|isn|wasn|doesn|didn|don|aren|hasn).?t)\b/i
export function _caramelSaysAccepted(text, before) {
    const old = new Set(_caramelSentencesOf(before))
    return _caramelSentencesOf(text).some(
        s =>
            !old.has(s) &&
            _CARAMEL_ACCEPTED_RE.test(s) &&
            _caramelNamesCoupon(s) &&
            !_CARAMEL_NEGATION_RE.test(s) &&
            !_caramelFinderSaysNo(s),
    )
}
export function _caramelSentencesOf(text) {
    // A sentence ends at ./!/? plus the whitespace after it, or at a newline.
    // The break goes in as a newline after the punctuation (no regex
    // lookbehind: Safari before 16.4 lacks it), then one split on newlines.
    return (text || '')
        .replace(/([.!?])\s+/g, '$1\n')
        .split(/\n+/)
        .map(s => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
}
// How long the total gets to move after a refusal-shaped sentence appears.
const CARAMEL_ANSWER_GRACE_MS = 1500
// How a finder-picked box's total settles before the verdict: read every
// CARAMEL_FINDER_READ_MS; an unmoved total is settled on two equal reads, a
// moved one must hold for CARAMEL_FINDER_HOLD_MS of equal reads; never more
// than CARAMEL_FINDER_SETTLE_READS reads in all.
const CARAMEL_FINDER_READ_MS = 250
const CARAMEL_FINDER_HOLD_MS = 1500
const CARAMEL_FINDER_HOLD_READS =
    CARAMEL_FINDER_HOLD_MS / CARAMEL_FINDER_READ_MS
const CARAMEL_FINDER_SETTLE_READS = 12
// How long a finder-picked box keeps waiting after its total area re-draws
// with the same number (T-10533): Shopify checkouts land the discount 2-4 s
// after that re-draw.
const CARAMEL_REDRAW_WAIT_MS = 4000
// How long a disabled Apply button gets to be enabled after the code is typed.
const CARAMEL_APPLY_ENABLE_WAIT_MS = 1500

// A store's fresh sentence that refuses THIS code: it names the code, or says
// the code is invalid, expired, unknown. A caveat printed as a code applies
// ("Limit one offer per order", "Promo code applied. Cannot be combined with
// other offers.") is not one — the total decides those.
const _CARAMEL_REFUSES_CODE_RE =
    /\b(invalid|not valid|isn.t valid|is not an? valid|no longer valid|expired|not recogni[sz]ed|does not exist|doesn.t exist|not found|incorrect (code|coupon|promo|voucher)|unknown (code|coupon|promo|voucher)|ung[üu]ltig|abgelaufen|no es v[aá]lido|n.est pas valide|non valid[oa]|ongeldig)\b/i
// Judged sentence by sentence: "SAVE20 applied! Cannot be combined with other
// offers." names the code in a sentence that accepts it, and refuses nothing.
export function _caramelRefusesTheCode(text, code) {
    const c = String(code || '')
        .trim()
        .toLowerCase()
    return _caramelSentencesOf(String(text || '')).some(s => {
        if (_CARAMEL_ACCEPTED_RE.test(s) && !_CARAMEL_NEGATION_RE.test(s))
            return false
        if (_CARAMEL_REFUSES_CODE_RE.test(s)) return true
        return (
            c.length >= 3 &&
            s.toLowerCase().includes(c) &&
            _CARAMEL_NEGATION_RE.test(s) &&
            !/\bcombin|\bstack/i.test(s)
        )
    })
}

// A store refusing a code because a discount is already on the order ("X
// couldn't be used with your existing discounts", "Cannot be combined with
// other offers", "Ein Rabatt wurde bereits angewendet"). The runner reads it as
// a sign that an earlier code landed after its own wait (T-10544).
// Sentences arrive with their whitespace collapsed (_caramelSentencesOf), so a
// space is a space. "cumulab" is French, Spanish and Italian at once.
// The words for a discount; "code" is only in the second, because "try other
// codes" is a plain refusal.
const _CARAMEL_DISCOUNT_WORDS =
    '(discount|offer|promo|coupon|voucher|deal|reduction)'
const _CARAMEL_CODE_WORDS = '(discount|offer|promo|coupon|voucher|code)'
const CARAMEL_EXISTING_DISCOUNT_RE = new RegExp(
    String.raw`\b(existing|current|other) ${_CARAMEL_DISCOUNT_WORDS}|already (been )?applied(?! to (an?|another|a previous|a prior) order)|already (has|have|contains?) an? ${_CARAMEL_DISCOUNT_WORDS}|n.?t (be )?(combined|stacked|used (together )?with [^.!?]{0,30}${_CARAMEL_CODE_WORDS})|(not |non-?)(combin|stack)able|only one ${_CARAMEL_CODE_WORDS}|one ${_CARAMEL_CODE_WORDS}s? per order|nicht (mit (anderen|bestehenden|weiteren)|kombinierbar)|kombiniert werden|bereits (ein (rabatt|gutschein)|angewendet)|cumulab|ne peut (pas )?.tre (combin|cumul)|autres? (r.duction|remise|promotion|offre)|d.j. appliqu|no (se )?pueden? (combinar|acumular)|otr[oa]s? (descuento|cup|promoci|oferta)|ya (est. |se ha |ha sido )?aplicad|non (pu.|possono) essere (combinat|cumulat)|altri (sconti|codici|coupon|buoni)|gi. applicat|niet (te )?(combineren|stapelen)|niet (worden )?gecombineerd|andere (korting|actie|aanbieding)|\bal toegepast`,
    'i',
)
// Every sentence is either that refusal or neutral: a sentence that also calls
// the code invalid or expired, or one that accepts it ("Promo code applied.
// Cannot be combined with other offers."), is not this answer.
export function caramelRefusedForExistingDiscount(text) {
    const said = _caramelSentencesOf(String(text || ''))
    return (
        said.some(s => CARAMEL_EXISTING_DISCOUNT_RE.test(s)) &&
        !said.some(
            s =>
                !CARAMEL_EXISTING_DISCOUNT_RE.test(s) &&
                (_CARAMEL_REFUSES_CODE_RE.test(s) ||
                    (_CARAMEL_ACCEPTED_RE.test(s) &&
                        !_CARAMEL_NEGATION_RE.test(s))),
        )
    )
}

// Which of `codes` the order shows as applied, the most recent first: a word
// of an applied row (the config's, or the generic ones) or of a Shopify
// checkout's reduction tag ("ADRIANR15 AdrianR15") equal to the code, any case.
// Shopify's current checkout has no #reduction-tags: each code is a tag group
// (<div id="tag-0" role="group">FREE FREE<button aria-label="Remove FREE"
// data-event-name="remove_discount_code">) in the "Discount code or gift
// card" list (neweracap.com, live 2026-10-30). Only a group whose button
// removes a discount code counts, so an applied gift card names nothing; the
// button's label is read too, as it names the code on its own.
const _CARAMEL_SHOPIFY_REMOVE_CODE =
    'button[data-event-name="remove_discount_code"]'
export function caramelCodeOnOrder(rec, codes) {
    const words = new Set(
        [
            ...qAll(findAppliedSelector(rec)),
            ...qAll('#reduction-tags li, [id^="reduction-tag-"]'),
            ...qAll(_CARAMEL_SHOPIFY_REMOVE_CODE).map(b =>
                b.closest('[role="group"]'),
            ),
        ]
            .filter(el => el && _isVisible(el) && !caramelRowReadsRejected(el))
            .flatMap(el =>
                [
                    el.innerText ?? el.textContent,
                    el
                        .querySelector(_CARAMEL_SHOPIFY_REMOVE_CODE)
                        ?.getAttribute('aria-label'),
                ]
                    .join(' ')
                    .toUpperCase()
                    .split(/[^\p{L}\p{N}_-]+/u),
            ),
    )
    for (let i = codes.length - 1; i >= 0; i--)
        if (words.has(String(codes[i]).toUpperCase())) return codes[i]
    return null
}

// The finder's total read after `code` was submitted. caramelFinderTotalNow
// reads a $0.00 total as NaN, since zero is what a half-drawn summary shows.
// It counts as 0 only when the order names the code, the same rule as the
// late credit in coupon-runner.js: neweracap.com's "Free" took the order to
// $0.00 in its own attempt and was ruled out (T-11045). The row read is the
// one caramelFinderTotalNow kept marked, and only while it is shown.
export function _caramelFinderTotalAfter(rec, code) {
    const now = caramelFinderTotalNow(rec)
    if (!Number.isNaN(now) || !code) return now
    const el = qOne(rec.priceContainer)
    return el &&
        _isVisible(el) &&
        getPrice(rec.priceContainer, { returnLargest: true }) === 0 &&
        caramelCodeOnOrder(rec, [code])
        ? 0
        : now
}

function _caramelRejectionSentences(scope) {
    const tidy = t => (t || '').trim().replace(/\s+/g, ' ')
    // The shown text of el without its controls ("Code <b>X</b> is not
    // valid. <a>Learn more</a>" reads "Code X is not valid.").
    const shownWords = node =>
        [...node.childNodes]
            .map(n =>
                n.nodeType === 3
                    ? n.textContent
                    : n.nodeType === 1 &&
                        !n.matches(_CARAMEL_CONTROLS) &&
                        !n.matches('script, style, noscript, template') &&
                        _isVisible(n)
                      ? shownWords(n)
                      : '',
            )
            .join('')
    const words = el =>
        tidy(
            el.querySelector(_CARAMEL_CONTROLS) ? shownWords(el) : el.innerText,
        )
    // One read in the common case: nothing here says no.
    if (!_caramelFinderNoPhrase(scope.innerText || '')) return []
    const says = el =>
        !el.closest('script, style, noscript, template') &&
        _isVisible(el) &&
        _caramelFinderNoPhrase(el.innerText || '')
    // The scope itself counts: a bare message element has no children.
    return [scope, ...scope.querySelectorAll('*')]
        .filter(el => says(el) && ![...el.children].some(says))
        .map(words)
        .filter(_caramelFinderSaysNo)
}

// The store's message itself: an innermost element under scope whose text
// carries the rejection phrase, preferring one that was not on the page before
// we submitted (a static hint like "Enter a valid code" is furniture). null
// when it is not one short element.
function _caramelSmallestSaying(scope, priorText) {
    const texts = _caramelRejectionSentences(scope)
    const best =
        texts.find(t => caramelQuoteIsAttributable(t, priorText)) || texts[0]
    return best && best.length <= 200 ? best : null
}

// A box the extension found on an earlier visit and saved as the store's
// config (the feed marks it `savedBox`, supportedStoresCache.ts) names no
// place where the store answers, exactly like a box the finder picks now. Its
// answer is read the same way: a refusal sentence beside the box or in a page
// alert ends the wait and is quoted on its own. Measured on bumbleandbumble.com
// (2026-10-22): read as a plain config, every refused code waited the full 10s
// and was quoted with the Apply button's label ("apply. The offer code … is
// not valid."). Only the READING is shared: the total and the success rules
// of a saved box stay a config's (rec.caramelFound is the finder's alone).
function _caramelReadsLikeFound(rec) {
    return (
        rec?.caramelFound === true ||
        (rec?.savedBox === true && !rec.errorIndicator)
    )
}

function detectCouponError(rec, baseline, code, priorText, alertsBefore) {
    // baseline is what snapshotErrorState() returned BEFORE the apply.
    // code is the coupon string we just tried.
    //
    // We only call something an "error" if the change is "about" this
    // attempt. Sites like logos.com keep an aria-live status region
    // permanently mounted and rotate text through it (success messages,
    // hints, prior errors) — naive presence checks on those false-positive
    // forever and the loop never stops on a valid coupon.
    if (rec.errorIndicator) {
        const el = _firstVisibleErrorEl(rec)
        if (el && _isVisible(el)) {
            const t = (el.innerText || '').trim()
            if (t.length) {
                const tl = t.toLowerCase()
                // Strongest signal: text mentions the code we just tried.
                if (code && tl.includes(code.toLowerCase())) return t
                // Strong signal: classic rejection vocabulary.
                if (ERROR_WORDS_RE.test(tl)) return t
                // Otherwise — status text without classic vocabulary. Treat
                // as OUR error when the container first appeared OR was
                // EMPTY before this attempt (empty→text is attempt-caused —
                // login-required / min-spend style messages). Pre-existing
                // text that merely changed stays ambiguous (aria-live regions
                // that rotate stale copy — the logos.com trap).
                if (
                    baseline &&
                    (!baseline.visible || !baseline.text) &&
                    _isVisible(el)
                ) {
                    return t
                }
                return null // generic / stale status copy → not our error
            }
        }
    }
    // Generic: look near the input for an inline error matching common phrases.
    const input = pickBestMatch(rec.couponInput)
    if (!input) return null
    let scope = input.parentElement
    const readsLikeFound = _caramelReadsLikeFound(rec)
    const saysNo = readsLikeFound
        ? _caramelFinderSaysNo
        : t => GENERIC_ERROR_TEXT_RE.test(t)
    // A sentence that was on the page before we submitted, kept in case
    // nothing newer turns up (it is then quoted as before, errorIsNew false).
    let standing = null
    for (let d = 0; d < 5 && scope; d++) {
        const text = (scope.innerText || '').trim()
        if (text && saysNo(text)) {
            // A finder-picked box (coupon-box-discovery.js): quote the element
            // that says it, not a window around it. The window would carry
            // the field's own label and button ("Promo code Apply Sorry, …"),
            // and the quote goes to the shopper and into the report.
            // No such element is no quote: the window would hand over
            // whatever sits near the words, a form field's own error included.
            // A level whose saying element is the field's own error goes on
            // climbing: the store's refusal may sit one level up. So does a
            // level whose only such sentence was already there: on
            // bumbleandbumble.com the fieldset always reads "Discount codes
            // cannot be combined with other discount codes." and the refusal
            // ("The offer code … is not valid.") is drawn two levels higher
            // (measured live 2026-10-22).
            if (readsLikeFound) {
                const said = _caramelSmallestSaying(scope, priorText)
                if (said && caramelQuoteIsAttributable(said, priorText))
                    return said
                standing ??= said
                scope = scope.parentElement
                continue
            }
            return caramelQuoteAround(
                text,
                Math.max(0, text.search(GENERIC_ERROR_TEXT_RE)),
            )
        }
        scope = scope.parentElement
    }
    return readsLikeFound
        ? (_caramelPageAlertSaying(alertsBefore) ?? standing)
        : null
}

// The quote around the refusal words at `idx`: up to 40 characters before and
// 120 after, cut at whole words and kept to the refusal's own line, so the
// field's label and button on the lines above ("Promo code / Apply") stay out
// of it. A fixed slice started mid-word: shoppers were shown, and reports
// saved, "ly The promotional code you entered is not valid." (the tail of
// "Apply"). Exported for tests.
export function caramelQuoteAround(text, idx) {
    let start = Math.max(0, idx - 40)
    let end = Math.min(text.length, idx + 120)
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1
    const lineEnd = text.indexOf('\n', idx)
    if (lineStart > start) start = lineStart
    else if (start > 0 && /\S/.test(text[start - 1])) {
        const gap = text.slice(start, idx).search(/\s/)
        start = gap === -1 ? idx : start + gap + 1
    }
    if (lineEnd !== -1 && lineEnd < end) end = lineEnd
    else if (end < text.length && /\S/.test(text[end])) {
        const lastGap = text.slice(idx, end).search(/\s\S*$/)
        if (lastGap > 0) end = idx + lastGap
    }
    return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

// A page's alert regions: where a cart that answers far from the box puts its
// answer.
const _CARAMEL_PAGE_ALERTS =
    '[role="alert"], [aria-live="assertive"], [aria-live="polite"]'

// The store refusing a code in an alert region of the page rather than beside
// the box. pureformulas.com, measured live 2026-10-22: a refused code is
// answered only by one banner at the top of the cart ("Oops! This code can't
// be applied. …"), outside the five levels read around the box, so the run saw
// no answer and stopped after two codes. Only for a box the finder picked (a
// config names its own errorIndicator), and only a sentence that is about a
// code and was not there before we submitted: a stock or shipping notice in
// the same region is not the store's answer to us.
//
// "Not there before" is judged per alert element, not by the page's text: the
// same cart removes the banner on every submit and draws a NEW one with the
// very same sentence for the next refused code, which a text comparison would
// read as the old answer. An alert that was already showing keeps counting
// only for words it did not hold before.
function _caramelPageAlertsNow() {
    const now = new Map()
    for (const el of document.querySelectorAll(_CARAMEL_PAGE_ALERTS))
        now.set(el, _isVisible(el) ? el.innerText || '' : '')
    return now
}
function _caramelPageAlertSaying(alertsBefore) {
    if (!alertsBefore) return null
    for (const el of document.querySelectorAll(_CARAMEL_PAGE_ALERTS)) {
        if (!_isVisible(el)) continue
        const before = alertsBefore.get(el) ?? ''
        const said = _caramelSmallestSaying(el, before)
        if (
            said &&
            _caramelNamesCoupon(said) &&
            caramelQuoteIsAttributable(said, before)
        )
            return said
    }
    return null
}

/* The store's verdict on a code we submitted, read on the page it navigated to.
 *
 * Classic form-POST carts (motoin.de, proaudiostar.com) answer an applied code
 * with a full page load, which destroys the content script mid-attempt. When we
 * come back we have no before-picture to compare against, so the resume path
 * fell back to “check your order summary to see whether it applied” — while
 * motoin, one inch above that sentence, was printing “Dieser Gutschein ist
 * abgelaufen”: the code had expired, and it had said so plainly.
 *
 * Attribution can't work by comparison here (there is no earlier state of this
 * document to compare with), so it works by content instead, and only on
 * evidence a label cannot fake: the text NAMES the code we just submitted, or it
 * uses the vocabulary of a rejection. A promo field's label does neither.
 */
// Called from store-detect.js (cross-file content-script call — oxlint's
// per-file analysis can't see it).
export function caramelPostNavigationVerdict(rec, code) {
    if (!rec) return null
    const el = _firstVisibleErrorEl(rec)
    if (!el || !_isVisible(el)) return null
    const text = ((el.innerText ?? el.textContent) || '').trim()
    if (!text) return null
    const lower = text.toLowerCase()
    const namesOurCode =
        !!code && lower.includes(String(code).toLowerCase().trim())
    // Both vocabularies, because they are complementary rather than layered:
    // ERROR_WORDS_RE carries the reasons ("already used", "minimum"),
    // GENERIC_ERROR_TEXT_RE the non-English rejections. A rejection in either
    // counts as one.
    if (
        namesOurCode ||
        ERROR_WORDS_RE.test(lower) ||
        GENERIC_ERROR_TEXT_RE.test(lower)
    )
        return text
    return null
}

/* --------------------------------------------------  cart snapshot + verdict
 * The before-picture and the after-reading of one coupon submission, shared by
 * two callers that differ only in WHO pressed the button: applyCoupon (we typed
 * and clicked) and code-capture.js (the shopper did). Extracted from
 * applyCoupon unchanged (2026-10-02) so a shopper-typed code is judged by the
 * exact rule our own attempts are — a second, drifting copy of "did the store
 * accept it?" would be a defect. */

/* Everything the verdict is compared against, read BEFORE the submission.
 * Synchronous on purpose: capture-phase listeners must snapshot before the
 * store's own handler reacts to the shopper's click. */
// Called from code-capture.js (cross-file content-script call).
export function caramelSnapshotCart(rec, code = '') {
    const hasPriceCfg = !!rec.priceContainer
    // A finder's total is read the way every later read is: a store that
    // re-drew its cart since the last code took the marked row with it, and a
    // plain read then has no baseline at all. Measured live: the next code was
    // judged before the store answered, and its 5% off was never counted.
    const original = !hasPriceCfg
        ? NaN
        : rec.caramelFound
          ? caramelFinderTotalNow(rec, document, true, code)
          : getPrice(rec.priceContainer, { returnLargest: true })
    // EVERY number the container held before we touched it — the post-apply
    // read needs to know which prices are new (see its comment).
    const originalPrices = hasPriceCfg ? _caramelLastPrices.slice() : []

    // Snapshot DOM signals BEFORE we apply, so we can compare after.
    const appliedSel = findAppliedSelector(rec)
    const beforeAppliedNodes = caramelAcceptedRowCount(appliedSel)
    // Which rows were already there, and what they said: the verdict's
    // appliedRows lists only the ones the store drew for this submission (by
    // node, and by text, since a re-render replaces every node).
    const beforeEls = qAll(appliedSel)
    const beforeAppliedRows = new Set(beforeEls)
    const beforeAppliedTexts = new Set(beforeEls.map(_caramelRowOwnText))
    const errorBaseline = snapshotErrorState(rec)
    const priorAreaText = _caramelCouponAreaText(rec)
    const alertsBefore = _caramelReadsLikeFound(rec)
        ? _caramelPageAlertsNow()
        : null
    return {
        hasPriceCfg,
        original,
        originalPrices,
        appliedSel,
        beforeAppliedNodes,
        beforeAppliedRows,
        beforeAppliedTexts,
        errorBaseline,
        priorAreaText,
        alertsBefore,
    }
}

function _caramelRowOwnText(row) {
    return ((row.innerText ?? row.textContent) || '')
        .replace(/\s+/g, ' ')
        .trim()
}

/* The store's answer when it gives it as a row: a row the store drew for this
 * submission, among its applied coupons, that says the code was not applied.
 * Salesforce Commerce Cloud carts answer a code that exists but does not fit
 * the cart this way, with no error text anywhere (aquasana.com 2026-10-27:
 * "JULY50 NOT APPLIED ×" under .coupon-price-adjustment). The row was already
 * refused as a success (caramelAcceptedRowCount), but nothing took it as an
 * answer, so every such code read as silence and two of them ended the run as
 * a checkout "not accepting injection", eight codes untried (T-9569). New by
 * text, as the verdict's appliedRows: a re-render replaces every node. */
function _caramelRejectedRowAnswer(appliedSel, beforeAppliedTexts) {
    const row = qAll(appliedSel).find(
        el =>
            !beforeAppliedTexts.has(_caramelRowOwnText(el)) &&
            caramelRowReadsRejected(el),
    )
    return row ? _caramelRowOwnText(row) || null : null
}

// An applied row's own text, and that text with up to two enclosing levels
// (stopping below the one that holds the promo box, whose label would speak
// for every row): a config can point at an element holding only the code,
// while the line around it says "Gift Certificate". `levels`: how many were
// read (0 = the promo box's own container held the row). Shopify measured
// live 2026-10-26: #reduction-tags li reads "ADRIANR15 AdrianR15", and the
// box's container is five levels up.
function _caramelRowWithContext(row, input) {
    const own = _caramelRowOwnText(row)
    const parts = [own]
    let el = row.parentElement
    for (let d = 0; d < 2 && el && el !== document.body; d++) {
        if (input && el.contains(input)) break
        parts.push((el.innerText ?? el.textContent) || '')
        el = el.parentElement
    }
    return { text: own, context: parts.join(' '), levels: parts.length - 1 }
}

/* Waits for the store's answer to `opts.code`, then applies the success rules.
 * Resolves { success, priceDropped, newTotal, committed, errorMsg, errorIsNew,
 * answeredByRow (the store's answer was a "not applied" row: take it off),
 * appliedRows (each row node drawn for THIS submission: { text, context,
 * levels, textSeenBefore }),
 * appliedRowsText (every applied row's text, joined) }.
 * `opts.timeoutMs` bounds the wait for the FIRST observable signal (default
 * 10s). `opts.redact` keeps the code and page text out of this helper's log
 * lines (used for shopper-typed codes). Callers must invoke this synchronously after the submission (or, for
 * the shopper's capture-phase click, synchronously with the snapshot) because
 * the waiter's own baselines are taken at call time. */
// Called from code-capture.js (cross-file content-script call).
export async function caramelAwaitCouponVerdict(rec, snapshot, opts) {
    const code = opts?.code
    // Polaris (Shopify) checkouts often respond in 5-8s for the apply
    // round-trip — 4s was clipping valid codes. Bumped to 10s; the loop
    // still races so a faster site exits as soon as a signal lands.
    const APPLY_WAIT_MS = opts?.timeoutMs ?? 10000
    const {
        hasPriceCfg,
        original,
        originalPrices,
        appliedSel,
        beforeAppliedNodes,
        beforeAppliedRows,
        beforeAppliedTexts,
        errorBaseline,
        priorAreaText,
        alertsBefore,
    } = snapshot

    /* 4] wait for result — smart waiter: poll DOM up to APPLY_WAIT_MS for the
         FIRST observable signal (success row appears OR error region
         gains text). Many sites (logos.com, hybris-style carts) need
         1.5-3s to render their applied row; fixed 1.2s sleeps cause
         the next attempt to mis-attribute the prior code's row. */
    async function waitForCartSignal(maxMs) {
        const baseSuccess = qAll(appliedSel).length
        // Use _firstVisibleErrorEl so multi-error-container sites
        // (paragonsports-class — empty placeholder + real error) aren't
        // permanently latched to the empty placeholder's "" baseline.
        const baseErrEl = _firstVisibleErrorEl(rec)
        const baseErr = baseErrEl ? (baseErrEl.innerText || '').trim() : ''
        // A store that answers every bad code with the same sentence (Shopify:
        // "Enter a valid discount code or gift card") takes the previous code's
        // sentence down and draws it again, so its text never differs from
        // baseErr and each code after the first waited out the whole window
        // (comfrt.com 2026-10-26: 10s a code, 4 of 8 codes in the budget,
        // T-9176). Once that sentence has gone (blank or hidden at a read, or
        // its node removed from the page), the error that comes back is the
        // store's answer to this code. Only ends the wait; the verdict below
        // still reads the error the way it always has.
        let baseErrGone = false
        const startedAt = performance.now()
        while (performance.now() - startedAt < maxMs) {
            const nowSuccess = qAll(appliedSel).length
            if (nowSuccess > baseSuccess) return 'committed'
            const errEl = _firstVisibleErrorEl(rec)
            const t =
                errEl && _isVisible(errEl) ? (errEl.innerText || '').trim() : ''
            if (baseErr && (!t || (baseErrEl && !baseErrEl.isConnected)))
                baseErrGone = true
            if (t.length && (t !== baseErr || baseErrGone)) return 'errored'
            await sleep(200)
        }
        return 'timeout-' + maxMs + 'ms'
    }
    // Looked up again on every read (waitForTotalChange): a store may answer
    // by drawing a new total element.
    const findPriceEl = () =>
        qOne(rec.priceContainer) ||
        document.getElementById(
            rec.priceContainer.match(/\[id=['"]([^'"]+)['"]\]/)?.[1] || '',
        )
    const priceEl = hasPriceCfg ? findPriceEl() : null
    const waiters = [waitForCartSignal(APPLY_WAIT_MS)]
    // A box the finder picked has no error or success selector of its own.
    // Two waiters stand in for them:
    //   · its small container (rec.caramelAnswer) saying a NEW rejection
    //     sentence is the store refusing the code. Any other change (the button
    //     reading "Applying…") is not an answer, so it never ends the wait.
    //   · the finder's total moving. Read afresh each time, because a cart
    //     that re-renders its summary replaces the row we marked.
    let answerEl = rec.caramelAnswer ? qOne(rec.caramelAnswer) : null
    if (answerEl) {
        // The sentences, not just the words: a second refused code changes
        // "the code A is not valid" into "the code B is not valid". A store
        // that re-draws the section to answer gets its new section read.
        // Looked for again at most every 500ms for the whole window: a section
        // that shows a spinner first has no box to find yet.
        let remarkedAt = 0
        let remarked = false
        // The page as it read before this code, so the area found after a
        // re-draw (often a wider one) does not count its standing words ("Enter
        // a valid code") as the store's answer to us.
        const pageBefore = document.body?.innerText || ''
        const rejections = () => {
            if (
                !answerEl.isConnected &&
                performance.now() - remarkedAt > 500 &&
                ((remarkedAt = performance.now()),
                caramelRemarkFoundBox(true, rec))
            ) {
                answerEl = qOne(rec.caramelAnswer) || answerEl
                remarked = true
            }
            const said = _caramelRejectionSentences(answerEl)
            return remarked
                ? said
                      .filter(s => caramelQuoteIsAttributable(s, pageBefore))
                      .join(' ¶ ')
                : said.join(' ¶ ')
        }
        const before = rejections()
        const shownBefore = answerEl.innerText || ''
        waiters.push(
            (async () => {
                const startedAt = performance.now()
                while (performance.now() - startedAt < APPLY_WAIT_MS) {
                    const now = rejections()
                    // "Promo code applied. Cannot be combined with other
                    // offers." is an acceptance with a caveat: leave the
                    // verdict to the total.
                    if (
                        now &&
                        now !== before &&
                        !_caramelSaysAccepted(answerEl.innerText, shownBefore)
                    )
                        return 'answered'
                    await sleep(200)
                }
                return 'answer-timeout'
            })(),
        )
    }
    // A saved box (_caramelReadsLikeFound) has no rec.caramelAnswer: the
    // refusal is looked for around its input on each read, by the very reader
    // the verdict uses below, so the wait and the verdict agree on what the
    // store said. Only a sentence that was not there before we submitted ends
    // the wait.
    if (_caramelReadsLikeFound(rec) && !rec.caramelFound) {
        waiters.push(
            (async () => {
                const startedAt = performance.now()
                while (performance.now() - startedAt < APPLY_WAIT_MS) {
                    await sleep(200)
                    const said = detectCouponError(
                        rec,
                        errorBaseline,
                        code,
                        priorAreaText,
                        null,
                    )
                    if (said && caramelQuoteIsAttributable(said, priorAreaText))
                        return 'answered'
                }
                return 'answer-timeout'
            })(),
        )
    }
    // A found or saved box whose store answers in a page alert instead
    // (_caramelPageAlertSaying): that answer ends the wait too.
    if (_caramelReadsLikeFound(rec)) {
        waiters.push(
            (async () => {
                const startedAt = performance.now()
                while (performance.now() - startedAt < APPLY_WAIT_MS) {
                    await sleep(200)
                    if (_caramelPageAlertSaying(alertsBefore)) return 'answered'
                }
                return 'alert-timeout'
            })(),
        )
    }
    if (rec.caramelFound && hasPriceCfg) {
        waiters.push(
            (async () => {
                const startedAt = performance.now()
                while (performance.now() - startedAt < APPLY_WAIT_MS) {
                    await sleep(250)
                    const now = _caramelFinderTotalAfter(rec, code)
                    if (Number.isFinite(now) && now !== original)
                        return 'total-moved'
                }
                return 'total-timeout'
            })(),
        )
    }
    // A price-watch timeout means "the total didn't change" — that's a
    // no-signal outcome, NOT a coupon error, so the waiter RESOLVES
    // 'price-nochange' and a failed apply falls through to the real
    // committed / error-text detection below. A synthetic timeout error was
    // once misread by the loop as a cart "signal" (sawSignal=true), defeating
    // the no-signal early-exit and making dead checkouts churn all 8 codes
    // (~80-100s) instead of bailing after ~2 (~20s).
    //
    // For a box the finder picked, new text that still reads as the SAME total
    // is a re-draw, not the store's answer: a checkout that re-draws its
    // summary row right after Apply ended the wait there, the unchanged total
    // ruled the code out, and the discount landed a moment later
    // (kipling-usa.com 2026-10-30, T-10533: the order carried -$11.24 while
    // the shopper was told nothing worked). So after such a re-draw the wait
    // goes on, for at most CARAMEL_REDRAW_WAIT_MS, until the total reads as a
    // different number or the store refuses THIS code (a sentence that was not
    // on the page before we submitted). A reading the finder cannot parse (a
    // skeleton row mid re-draw) is not an answer either. The cap bounds what a
    // refused code costs when its refusal is not recognised.
    if (priceEl && rec.caramelFound)
        waiters.push(
            (async () => {
                const startedAt = performance.now()
                const left = () =>
                    APPLY_WAIT_MS - (performance.now() - startedAt)
                const via = await waitForTotalChange(
                    findPriceEl,
                    priceEl.textContent,
                    left(),
                )
                if (via !== 'text-changed' || !Number.isFinite(original))
                    return via
                const redrawAt = performance.now()
                for (;;) {
                    // Zero or less is a placeholder caught mid-render, unless
                    // the order names the code (_caramelFinderTotalAfter);
                    // `now >= 0` also turns away an unreadable NaN.
                    const now = _caramelFinderTotalAfter(rec, code)
                    if (now >= 0 && now !== original) return via
                    const said = detectCouponError(
                        rec,
                        errorBaseline,
                        code,
                        priorAreaText,
                        alertsBefore,
                    )
                    if (said && caramelQuoteIsAttributable(said, priorAreaText))
                        return via
                    if (
                        left() <= 0 ||
                        performance.now() - redrawAt >= CARAMEL_REDRAW_WAIT_MS
                    )
                        return via
                    await sleep(200)
                }
            })(),
        )
    else if (priceEl)
        waiters.push(
            waitForTotalChange(findPriceEl, priceEl.textContent, APPLY_WAIT_MS),
        )

    const via = await Promise.race(waiters)
    log('Wait finished via', via)
    // A refusal-shaped sentence can come a moment before the total it
    // belongs with ("Limit one offer per order" printed as the code applies).
    // Give the total a short grace to move before the verdict is read.
    if (via === 'answered' && _caramelReadsLikeFound(rec) && hasPriceCfg) {
        const startedAt = performance.now()
        while (performance.now() - startedAt < CARAMEL_ANSWER_GRACE_MS) {
            await sleep(250)
            const now = rec.caramelFound
                ? _caramelFinderTotalAfter(rec, code)
                : getPrice(rec.priceContainer, { returnLargest: true })
            if (Number.isFinite(now) && now !== original) break
        }
    }
    // For a finder-picked box the total is the whole verdict: let it settle
    // (two equal reads in a row) so a number caught mid-render is not read as
    // the store's answer, and make sure the marker points at a live row.
    //
    // A total that MOVED is held longer (CARAMEL_FINDER_HOLD_MS of equal
    // reads): a cart that re-prices line by line shows a lower number for a
    // moment — the total without its shipping line — before the store's real
    // answer lands and it is back where it was. Two reads a quarter second
    // apart took that moment for a saving, told the shopper so, and saved the
    // box as a proven one for every later shopper on the store. An unmoved
    // total settles as before, so a refused code costs nothing more.
    if (rec.caramelFound && hasPriceCfg) {
        let last = _caramelFinderTotalAfter(rec, code)
        let held = 0
        for (let t = 0; t < CARAMEL_FINDER_SETTLE_READS; t++) {
            await sleep(CARAMEL_FINDER_READ_MS)
            const now = _caramelFinderTotalAfter(rec, code)
            if (!Number.isFinite(now) || now !== last) {
                held = 0
                last = now
                continue
            }
            if (now === original) break
            if (++held >= CARAMEL_FINDER_HOLD_READS) break
        }
    }

    // 5] Determine outcome:
    //   - committed = something visibly applied (DOM mutation)
    //   - stuck     = the row was still there 1.2s later (site didn't
    //                 auto-revert it). On no-priceContainer sites this
    //                 is the real "did it apply?" signal — sites like
    //                 logos.com keep an aria-live error region with
    //                 stale text that defeats errorMsg-based detection.
    //   - errorMsg  = error text appeared near input
    //   - savings   = price actually dropped
    const afterAppliedNodes = caramelAcceptedRowCount(appliedSel)
    const committed = afterAppliedNodes > beforeAppliedNodes
    let stuck = false
    if (committed) {
        await sleep(1200)
        const stuckCount = caramelAcceptedRowCount(appliedSel)
        stuck = stuckCount > beforeAppliedNodes
    }
    // The store's answer is read around the box: the one it drew, if it did.
    if (rec.caramelFound) caramelRemarkFoundBox(false, rec)
    const errorText = detectCouponError(
        rec,
        errorBaseline,
        code,
        priorAreaText,
        alertsBefore,
    )
    const rowAnswer = errorText
        ? null
        : _caramelRejectedRowAnswer(appliedSel, beforeAppliedTexts)
    const errorMsg = errorText || rowAnswer
    // The refused code stays on the cart as that row, and the next code is
    // then refused for it ("Coupon cannot be combined with other coupons
    // already in your cart", aquasana.com 2026-10-27): the runner takes it off.
    const answeredByRow = !!rowAnswer
    // Quotable only if the store said it BECAUSE of us (see
    // _caramelCouponAreaText). Detection above is deliberately untouched.
    const errorIsNew = caramelQuoteIsAttributable(errorMsg, priorAreaText)
    if (errorMsg && !errorIsNew) {
        // opts.redact: a SHOPPER-typed code (code-capture.js) never reaches a
        // log line, and neither does the page text, which can quote it. The
        // runner's own attempts keep their full diagnostics.
        log(
            'AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE',
            opts?.redact
                ? { redacted: true }
                : {
                      code,
                      text: String(errorMsg).slice(0, 140),
                      reason: 'this text was already on the page before we submitted — it is the store’s furniture, not its verdict',
                  },
        )
    }
    let newTotal = NaN
    let priceDropped = false
    if (hasPriceCfg) {
        // A finder record reads through the same guards as its waiters: the
        // same row, a positive amount (or a zero the order names the code
        // for). A refused read leaves no prices.
        const afterLargest = rec.caramelFound
            ? _caramelFinderTotalAfter(rec, code)
            : getPrice(rec.priceContainer, { returnLargest: true })
        const afterPrices =
            rec.caramelFound && isNaN(afterLargest)
                ? []
                : _caramelLastPrices.slice()
        /* The post-apply total is the number that actually MOVED, not the
         * biggest number in the box. `returnLargest` answers a different
         * question, and it is the wrong one the moment the price container
         * also holds an MSRP strikethrough or a "$500 off" banner: that
         * number never changes, so it wins `returnLargest` both before and
         * after, `priceDropped` reads false, and the discount measures as
         * exactly zero. The user is then told their total "hasn't changed
         * yet — it may need a minimum spend" while the cart on screen went
         * from $120.00 to $108.00, and the $12 is never banked. Proved in a
         * real browser on naturepedic's live config (tests/…-multi-price).
         *
         * caramelBaselineFor already stops a stray big number from
         * OVERstating a saving; this is the mirror defect — the same stray
         * number silently UNDERstating one to zero.
         *
         * A candidate must be BOTH below the pre-apply reading AND absent
         * from the pre-apply set: a static second line (shipping, a fee)
         * that was always there is not a discounted total, and treating it
         * as one would declare success on a code that did nothing. The
         * largest qualifying candidate is taken — the most conservative
         * one, since a higher total yields a smaller claimed saving. */
        const moved = afterPrices.filter(
            p => !isNaN(p) && p < original && !originalPrices.includes(p),
        )
        newTotal = moved.length ? Math.max(...moved) : afterLargest
        priceDropped = !isNaN(newTotal) && newTotal < original
        // A finder-read total of zero or less is a placeholder caught mid-
        // render (see caramelFinderTotalNow), never a measured saving, unless
        // it is a $0.00 the order names this code for (afterLargest is 0 only
        // then, see _caramelFinderTotalAfter).
        if (
            rec.caramelFound &&
            !(newTotal > 0) &&
            !(newTotal === 0 && afterLargest === 0)
        )
            priceDropped = false
        // A drop read off a new deduction line, beside the store's own fresh
        // rejection of the code, is not a saving (see finderTotal).
        if (rec.caramelNetted && errorIsNew) priceDropped = false
        // Nor is a drop beside the store's fresh refusal of THIS code, on a
        // box the finder picked: the store said the code is not valid and
        // something else (its own promotion landing) moved the total. Money
        // still wins over a caveat ("Limit one offer per order"), which
        // _caramelRefusesTheCode leaves alone.
        if (
            rec.caramelFound &&
            errorIsNew &&
            _caramelRefusesTheCode(errorMsg, code)
        ) {
            log('AUTO_INSERT_DROP_BESIDE_REFUSAL', {
                code,
                text: opts?.redact
                    ? '[redacted]'
                    : String(errorMsg).slice(0, 140),
                reason: 'the total moved while the store refused this code — not this code’s saving',
            })
            priceDropped = false
        }
    }
    // Success rules (in priority order):
    //  1. price dropped                       → real win
    //  2. committed AND row stuck             → site accepted it (no
    //                                            need to trust the
    //                                            often-noisy error region)
    //  3. committed AND no errorMsg           → fallback for sites that
    //                                            don't keep their list mounted
    //  4. otherwise                           → fail
    //
    // A promo box the finder picked (coupon-box-discovery.js, rec.caramelFound)
    // has no store-written success or error selector behind it: "something
    // committed" there is the generic applied-row guess, which a store's own
    // "code not valid" row can satisfy. So the money rule alone decides it:
    // the code worked only if the total went down.
    const success = rec.caramelFound
        ? priceDropped
        : priceDropped || (committed && stuck) || (committed && !errorMsg)
    // What the applied rows SAY (only read when something committed): lets a
    // caller tell a row that names the code from a generic "redeemed" row.
    const appliedEls = committed
        ? qAll(appliedSel).filter(el => !caramelRowReadsRejected(el))
        : []
    const appliedRowsText = appliedEls
        .map(el => (el.innerText ?? el.textContent) || '')
        .join(' ')
    const input = committed ? pickBestMatch(rec.couponInput) : null
    // `textSeenBefore`: a new node saying what a row already said before the
    // submission (a re-render, or the store re-drawing a code applied again).
    const appliedRows = appliedEls
        .filter(el => !beforeAppliedRows?.has(el))
        .map(el => ({
            ..._caramelRowWithContext(el, input),
            textSeenBefore: !!beforeAppliedTexts?.has(_caramelRowOwnText(el)),
        }))
    return {
        success,
        priceDropped,
        newTotal,
        committed,
        errorMsg,
        errorIsNew,
        answeredByRow,
        appliedRows,
        appliedRowsText,
    }
}

/* --------------------------------------------------  coupon attempt */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it) and from
// scripts/test-extension.mjs's Playwright harness.
export async function applyCoupon(code, rec) {
    const attemptStart = performance.now()
    log('AUTO_INSERT_ATTEMPT_START', code, { t: attemptStart })
    recordTiming('AUTO_INSERT_ATTEMPT_START', { code })
    try {
        /* 1] dismiss popup if present */
        if (rec.dismissButton) {
            const btn = qOne(rec.dismissButton)
            if (caramelIsForbiddenControl(btn)) {
                log('AUTO_INSERT_REFUSED_CONTROL', {
                    reason: 'dismiss selector resolved to an order-completing control',
                })
            } else if (btn) {
                btn.click()
                await sleep(180)
                log('Popup dismissed')
            }
        }

        /* 2] ensure input visible — "present" is NOT enough. Magento-class
             carts pre-render the whole coupon form inside a collapsed
             accordion (display:none content, visible "APPLY PROMO CODE"
             toggle). Typing into the hidden input and clicking the hidden
             apply button reaches NO form submission at all (proven live on
             naturepedic: hidden click → zero submit; after clicking the
             toggle, the identical sequence fires the real couponPost). So:
             if the input is missing OR hidden, click showInput and wait for
             the input to become VISIBLE, not merely attached. */
        if (rec.caramelFound) caramelRemarkFoundBox(!!rec.caramelAnswer, rec)
        let input = pickBestMatch(rec.couponInput)
        if (!input || !_isVisible(input)) {
            // The config's toggle, else the disclosure the box itself declares
            // (a config with no toggle, or one whose toggle no longer matches).
            const showBtn =
                (rec.showInput && pickBestMatch(rec.showInput, input)) ||
                caramelDisclosureFor(input)
            if (caramelIsForbiddenControl(showBtn)) {
                log('AUTO_INSERT_REFUSED_CONTROL', {
                    reason: 'showInput selector resolved to an order-completing control',
                })
            } else if (showBtn) {
                showBtn.click()
                try {
                    await waitForVisible(rec.couponInput, 3000)
                } catch (e) {
                    log(e)
                    // Late-bound accordion widgets (RequireJS) can miss the
                    // first click — one bounded retry.
                    showBtn.click()
                    try {
                        await waitForVisible(rec.couponInput, 1500)
                    } catch (e2) {
                        log(e2)
                    }
                }
                input = pickBestMatch(rec.couponInput)
            }
        }
        let applyBtn = pickBestMatch(rec.couponSubmit, input)
        if (!applyBtn && input) {
            // The config's apply selector matches nothing: the box's own
            // form may still hold its one button (caramelSubmitBesideInput).
            applyBtn = caramelSubmitBesideInput(input)
            if (applyBtn)
                log('APPLY_BUTTON_FROM_INPUT_FORM', {
                    reason: "the config's apply selector matches nothing",
                })
        }
        // Refuse to drive a control that completes the order. A config whose
        // apply selector resolved here is wrong, and clicking it would spend
        // the user's money instead of saving it — treat it as no button at all.
        //
        // The label test alone is not enough. A button reading "Apply Discount"
        // that is the checkout form's own submit control places the order with
        // an entirely innocent label, so the form it would submit is checked
        // too. Refusing costs a discount; not refusing costs an order.
        const applyBtnUnsafeForm =
            applyBtn && caramelFormSubmitIsUnsafe(applyBtn)
        if (caramelIsForbiddenControl(applyBtn) || applyBtnUnsafeForm) {
            log('AUTO_INSERT_REFUSED_CONTROL', {
                code,
                reason: applyBtnUnsafeForm
                    ? 'apply selector sits in a form that carries payment details or an order control'
                    : 'apply selector resolved to an order-completing control',
                label: (applyBtn.innerText || applyBtn.value || '').slice(
                    0,
                    60,
                ),
            })
            log('AUTO_INSERT_ATTEMPT_END', code, {
                success: false,
                elapsed: performance.now() - attemptStart,
            })
            return { success: false, applied: false }
        }
        if (!input || !_isVisible(input) || !applyBtn) {
            log('Input / apply button missing or hidden')
            log('AUTO_INSERT_ATTEMPT_END', code, {
                success: false,
                elapsed: performance.now() - attemptStart,
            })
            return { success: false, applied: false }
        }

        // Everything the verdict will be compared against, captured BEFORE we
        // touch the page (see caramelSnapshotCart).
        const snapshot = caramelSnapshotCart(rec, code)

        /* 3] fill & apply — choose method dynamically:
             a) if applyBtn === input → auto-validate on input event
             b) if applyBtn is a button/element distinct → full pointer+click sequence
             c) Enter-key submit also dispatched as a fallback for forms

           Why a full pointer sequence and not just .click(): some Shopify themes
           (paragonsports-class) gate the apply on `pointerdown` rather than the
           click event. A bare .click() fires the click handler but not the
           pointer chain, so the site's own JS rejects it. This sequence makes
           the extension match what a real user click dispatches (pointerdown →
           pointerup → mousedown → mouseup → click). Sites that genuinely
           require event.isTrusted=true (olaplex / paleoonthego) still won't
           accept this — those are correctly flagged extension_compatible:false
           by the agent's HARD VALIDATION 2 step. */
        setInputValue(input, code)
        if (applyBtn !== input) {
            // A store that enables Apply only once the field has text does
            // so on the framework's next tick, after the input event we just
            // dispatched. A click in the same tick lands on a still-disabled
            // button and nothing is submitted; the shopper's own click comes
            // much later and never meets this.
            if (applyBtn.disabled) {
                const until = performance.now() + CARAMEL_APPLY_ENABLE_WAIT_MS
                while (applyBtn.disabled && performance.now() < until)
                    await sleep(50)
                if (applyBtn.disabled)
                    log('AUTO_INSERT_APPLY_STILL_DISABLED', { code })
            }
            try {
                const r = applyBtn.getBoundingClientRect()
                const cx = r.x + r.width / 2
                const cy = r.y + r.height / 2
                const evtInit = {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                    view: window,
                    button: 0,
                }
                // Canonical browser ordering for a primary-pointer click:
                // pointerdown → mousedown → pointerup → mouseup → click.
                // The previous pd→pu→md→mu order broke React handlers on
                // Polaris-class checkouts (alwaystoast / skinnyfit / others
                // — verifier-validated codes silently dropped). Real-click
                // probe confirmed the UI accepts these codes when events fire
                // in canonical order.
                applyBtn.dispatchEvent(new PointerEvent('pointerdown', evtInit))
                applyBtn.dispatchEvent(new MouseEvent('mousedown', evtInit))
                applyBtn.dispatchEvent(new PointerEvent('pointerup', evtInit))
                applyBtn.dispatchEvent(new MouseEvent('mouseup', evtInit))
            } catch {
                // Older browsers without PointerEvent constructor — fall through
                // to plain click which still works on most sites.
            }
            applyBtn.click()
        }
        // Dispatch Enter on the input for sites that listen to keydown="Enter"
        // instead of a click. This used to be unconditional and described as
        // "harmless when no submit handler" — it is not. Enter submits the form
        // the input lives in, and the guard above only ever inspected elements
        // we were about to CLICK, so a coupon selector that had drifted onto a
        // field inside the checkout's own order form placed the order without
        // tripping a single refusal (QA sweep 2026-08-05, order placed once per
        // code). Enter is the one action here whose target is a form rather
        // than an element, so it gets the form check.
        if (caramelFormSubmitIsUnsafe(input)) {
            log('AUTO_INSERT_REFUSED_CONTROL', {
                code,
                reason: 'coupon input sits in a form that carries payment details or an order control — Enter not dispatched',
            })
        } else {
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    bubbles: true,
                }),
            )
        }

        /* 4] wait for result and read the verdict — see
             caramelAwaitCouponVerdict for the race and the success rules. */
        const {
            success,
            newTotal,
            committed,
            errorMsg,
            errorIsNew,
            answeredByRow,
        } = await caramelAwaitCouponVerdict(rec, snapshot, { code })
        const elapsed = performance.now() - attemptStart
        log('AUTO_INSERT_ATTEMPT_END', code, {
            success,
            newTotal,
            committed,
            errorMsg,
            elapsed,
        })
        recordTiming('AUTO_INSERT_ATTEMPT_END', {
            code,
            success,
            newTotal,
            committed,
            errorMsg,
            elapsed,
        })
        return {
            success,
            newTotal,
            committed,
            errorMsg,
            errorIsNew,
            answeredByRow,
        }
    } catch (err) {
        logError('applyCoupon error', err)
        log('AUTO_INSERT_ATTEMPT_END', code, {
            success: false,
            error: String(err),
            elapsed: performance.now() - attemptStart,
        })
        recordTiming('AUTO_INSERT_ATTEMPT_END', {
            code,
            success: false,
            error: String(err),
            elapsed: performance.now() - attemptStart,
        })
        // errorIsNew stays false: this is OUR exception text (a TypeError, a
        // selector that threw), and it was never something the store said.
        return {
            success: false,
            committed: false,
            errorMsg: String(err),
            errorIsNew: false,
        }
    }
}

/* ----------------------------------------------  discount-link apply */
// Runtime CAPABILITY detection — no store lists, no config inspection. Some
// checkout stacks ignore ALL synthetic DOM interaction on their discount form
// (isTrusted-gated Apply buttons — proven live on two independent stores), but
// the same platform exposes, on the SAME origin the user is browsing:
//   GET /cart.js            -> live cart JSON (totals in cents, token)
//   GET /discount/{code}    -> attaches the code to the session server-side
// Any site that isn't that platform simply fails the /cart.js shape probe and
// the normal config-selector DOM flow below runs unchanged.
export async function probeCartJson() {
    try {
        const r = await fetch('/cart.js', { credentials: 'same-origin' })
        if (!r.ok) return null
        const j = await r.json()
        if (
            j &&
            typeof j.token === 'string' &&
            typeof j.total_price === 'number' &&
            typeof j.item_count === 'number'
        )
            return j
    } catch {
        /* not this platform — probe is expected to fail elsewhere */
    }
    return null
}
// Per-origin short-term memory of codes we already tried, so a navigation-type
// apply (full-page POST → reload, Magento-class) doesn't make the next run
// re-grind the same rejected codes from #1 — one wasted reload per code.
// sessionStorage is per-origin and per-tab and dies with the tab; entries also
// expire on their own after 15 minutes so fresh runs eventually retry.
const CARAMEL_TRIED_KEY = 'caramel_tried_codes'
const CARAMEL_TRIED_TTL = 15 * 60 * 1000
export function _getTriedCodes() {
    try {
        const m = JSON.parse(sessionStorage.getItem(CARAMEL_TRIED_KEY) || '{}')
        const now = Date.now()
        for (const k of Object.keys(m)) {
            if (now - m[k] > CARAMEL_TRIED_TTL) delete m[k]
        }
        return m
    } catch {
        return {}
    }
}
/* Order a copy-list so the codes we already spent an attempt on sit at the
 * bottom.
 *
 * The manual list's whole job is "here is what to try yourself", and it was
 * leading with the codes the shopper had just watched fail. On allbirds the
 * progress bar counted through AFF-1023, FASTSHIP1023 and FLUFF and then
 * offered those three first; on proaudiostar — where every attempt costs a full
 * page reload — the list's first entry was LB15, the code the store had
 * rejected by name thirty seconds earlier.
 *
 * Only the ORDER changes. Nothing is hidden (a code the store refused from our
 * synthetic input can still work when pasted by hand) and nothing is labelled
 * rejected that we don't have the store's own words for. */
// Cross-file content-script call — per-file analysis can't see it.
export function caramelSinkTriedCodes(list, tried) {
    const seen = tried || _getTriedCodes() || {}
    return (Array.isArray(list) ? list : [])
        .map((c, i) => ({ c, i })) // index keeps the sort stable
        .sort(
            (a, b) =>
                (a.c && seen[a.c.code] ? 1 : 0) -
                    (b.c && seen[b.c.code] ? 1 : 0) || a.i - b.i,
        )
        .map(x => x.c)
}

export function _markTriedCode(code) {
    // Marked at attempt START, not at verdict — a full-page-POST apply can
    // destroy this script before the verdict lands.
    try {
        const m = _getTriedCodes()
        m[code] = Date.now()
        sessionStorage.setItem(CARAMEL_TRIED_KEY, JSON.stringify(m))
    } catch {
        /* storage unavailable — worst case a reload retries codes */
    }
}
// Release a code marked at attempt start whose attempt then produced NO
// evidence — no applied row, no store error, no readable total.
//
// Marking at start is right (see above), but leaving the mark on an attempt
// that proved nothing turns a momentary blindness into a permanent blacklist
// for the rest of the tab's session, and _untried in coupon-runner.js filters
// those codes out of the manual copy list too. So the user loses the code in
// BOTH directions.
//
// Measured twice on 2026-08-05, independently. toms.com: TOMS15 won a verified
// -$11.25 earlier in the day; on a later run the cart probe fell back to the
// DOM form, both attempts read newTotal NaN, and the user was told "didn't
// stick" with TOMS15 offered as the code to paste by hand — then a re-run
// logged SKIP_TRIED and could never reach it again. bombas.com: NATE, badged
// "Verified" in our own popup and worth a real -$11.10, vanished from the
// auto-apply queue AND the copy list, leaving 16 unevidenced codes in its
// place. Same mechanism burns codes tried against an EMPTY cart, where no
// total can move by definition.
export function _unmarkTriedCode(code) {
    try {
        const m = _getTriedCodes()
        if (!(code in m)) return
        delete m[code]
        sessionStorage.setItem(CARAMEL_TRIED_KEY, JSON.stringify(m))
    } catch {
        /* storage unavailable — the mark was best-effort anyway */
    }
}
/* Take every discount code off the cart.
 *
 * THE MEASUREMENT THE RESTORE PATH IS BUILT ON (live harney.com cart,
 * 2026-08-06, reproduced twice). /discount/{code} APPENDS; it does not replace.
 * Eight probes over the shopper's own HARNEY10 left the cart holding HARNEY10
 * live plus seven `applicable:false` entries — so probing never endangered it.
 * Re-sending HARNEY10 into that eight-deep list moved it to the END and killed
 * it: total_discount 1000 -> 0, no race about it. Clearing first and re-sending
 * restored the full -$10.00 on the same cart seconds later.
 *
 * Two rules follow, and coupon-runner.js applies both: never re-send a code the
 * cart already honours, and clear before a re-send that IS needed.
 *
 * Best-effort — a store that doesn't answer this leaves the cart as it was, and
 * every caller re-reads the cart rather than trusting either request.
 */
// Cross-file content-script call — per-file analysis can't see it.
export async function _caramelClearCartDiscounts() {
    try {
        const r = await fetch('/cart/update.js', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discount: '' }),
        })
        return !!r?.ok
    } catch {
        // Not this platform, or the store refused. The caller finds out from
        // the cart itself — there is nothing to report that a cart read won't
        // say better.
        return false
    }
}

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
export async function applyViaDiscountLink(code) {
    // The discount endpoint 302s to the storefront; we only need the session
    // cookie it sets, then re-read the live totals to see if the code took.
    // A later code simply replaces the session's discount, so probing several
    // codes leaves at most one (possibly ineffective) code attached — inert.
    try {
        await fetch('/discount/' + encodeURIComponent(code), {
            credentials: 'same-origin',
            redirect: 'follow',
        })
        return await probeCartJson()
    } catch {
        return null
    }
}
