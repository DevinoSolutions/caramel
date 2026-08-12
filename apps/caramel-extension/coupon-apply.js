// owns: coupon-apply engine — generic selectors, input/error detection, applyCoupon, discount-link fallback (GENERIC_* selectors, setInputValue, removeAppliedCoupon, detectCouponError, applyCoupon, probeCartJson, applyViaDiscountLink)
// load after: caramel-base.js, dom-utils.js, store-detect.js

// ES module since the WXT P1 port (2026-08-12). Same statements in the same
// order; the only new plumbing is explicit imports for the symbols this file
// used to read off the shared script realm, and `export` on the ones
// coupon-runner.js / store-detect.js call. This file publishes nothing on
// window/globalThis and has no effectful top-level statement, so it exports no
// init() — there is nothing for the composition entrypoint to call.
import { log, logError, recordTiming, sleep } from './caramel-base.js'
import {
    _caramelLastPrices,
    _isVisible,
    caramelFormSubmitIsUnsafe,
    caramelIsForbiddenControl,
    getPrice,
    pickBestMatch,
    qAll,
    qOne,
    waitForTextChange,
    waitForVisible,
} from './dom-utils.js'

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
const GENERIC_ERROR_TEXT_RE =
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
 * as before. */
const CARAMEL_REJECTED_ROW_RE = new RegExp(
    String.raw`\bnot\s+applied\b|\bnicht\s+angewendet\b|\bnon\s+appliqué`,
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
// Cross-file content-script call — per-file analysis can't see it.
// oxlint-disable-next-line no-unused-vars
function caramelAcceptedRowCount(sel) {
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
    const candidates = qAll(sel).filter(usable)
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
function _caramelCouponAreaText(rec) {
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
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
function caramelQuoteIsAttributable(quote, priorText) {
    const q = _caramelNormalizeQuote(quote)
    if (!q) return false
    return !_caramelNormalizeQuote(priorText).includes(q)
}

const ERROR_WORDS_RE =
    /\b(invalid|expired|not valid|doesn'?t apply|cannot be applied|cannot apply|already used|no longer|reached the limit|minimum|coupon code is required|wrong code)\b/i

function detectCouponError(rec, baseline, code) {
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
    for (let d = 0; d < 5 && scope; d++) {
        const text = (scope.innerText || '').trim()
        if (text && GENERIC_ERROR_TEXT_RE.test(text)) {
            const idx = text.search(GENERIC_ERROR_TEXT_RE)
            return text
                .slice(Math.max(0, idx - 40), idx + 120)
                .replace(/\s+/g, ' ')
                .trim()
        }
        scope = scope.parentElement
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
        let input = pickBestMatch(rec.couponInput)
        if ((!input || !_isVisible(input)) && rec.showInput) {
            const showBtn = pickBestMatch(rec.showInput, input)
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
        const applyBtn = pickBestMatch(rec.couponSubmit, input)
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

        const hasPriceCfg = !!rec.priceContainer
        const original = hasPriceCfg
            ? getPrice(rec.priceContainer, { returnLargest: true })
            : NaN
        // EVERY number the container held before we touched it — the post-apply
        // read below needs to know which prices are new (see its comment).
        const originalPrices = hasPriceCfg ? _caramelLastPrices.slice() : []

        // Snapshot DOM signals BEFORE we apply, so we can compare after.
        const appliedSel = findAppliedSelector(rec)
        const beforeAppliedNodes = caramelAcceptedRowCount(appliedSel)
        const errorBaseline = snapshotErrorState(rec)
        const priorAreaText = _caramelCouponAreaText(rec)

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

        /* 4] wait for result — smart waiter: poll DOM up to 4s for the
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
            const startedAt = performance.now()
            while (performance.now() - startedAt < maxMs) {
                const nowSuccess = qAll(appliedSel).length
                if (nowSuccess > baseSuccess) return 'committed'
                const errEl = _firstVisibleErrorEl(rec)
                if (errEl && _isVisible(errEl)) {
                    const t = (errEl.innerText || '').trim()
                    if (t.length && t !== baseErr) return 'errored'
                }
                await sleep(200)
            }
            return 'timeout-' + maxMs + 'ms'
        }
        let priceEl = null
        if (hasPriceCfg) {
            priceEl =
                qOne(rec.priceContainer) ||
                document.getElementById(
                    rec.priceContainer.match(/\[id=['"]([^'"]+)['"]\]/)?.[1] ||
                        '',
                )
        }
        // Polaris (Shopify) checkouts often respond in 5-8s for the apply
        // round-trip — 4s was clipping valid codes. Bumped to 10s; the loop
        // still races so a faster site exits as soon as a signal lands.
        const APPLY_WAIT_MS = 10000
        const waiters = [waitForCartSignal(APPLY_WAIT_MS)]
        // A price-watch timeout means "the total didn't change" — that's a
        // no-signal outcome, NOT a coupon error. Let it RESOLVE (swallow the
        // reject) so a failed apply falls through to the real committed / error-
        // text detection below, instead of aborting into the catch with a
        // synthetic "waitForTextChange timeout" errorMsg. That synthetic error
        // was being misread by the loop as a cart "signal" (sawSignal=true),
        // defeating the no-signal early-exit and making dead checkouts churn all
        // 8 codes (~80-100s) instead of bailing after ~2 (~20s).
        if (priceEl)
            waiters.push(
                waitForTextChange(priceEl, APPLY_WAIT_MS).catch(
                    () => 'price-nochange',
                ),
            )

        const via = await Promise.race(waiters)
        log('Wait finished via', via)

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
        const errorMsg = detectCouponError(rec, errorBaseline, code)
        // Quotable only if the store said it BECAUSE of us (see
        // _caramelCouponAreaText). Detection above is deliberately untouched.
        const errorIsNew = caramelQuoteIsAttributable(errorMsg, priorAreaText)
        if (errorMsg && !errorIsNew) {
            log('AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE', {
                code,
                text: String(errorMsg).slice(0, 140),
                reason: 'this text was already on the page before we submitted — it is the store’s furniture, not its verdict',
            })
        }
        let newTotal = NaN
        let priceDropped = false
        if (hasPriceCfg) {
            const afterLargest = getPrice(rec.priceContainer, {
                returnLargest: true,
            })
            const afterPrices = _caramelLastPrices.slice()
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
        }
        // Success rules (in priority order):
        //  1. price dropped                       → real win
        //  2. committed AND row stuck             → site accepted it (no
        //                                            need to trust the
        //                                            often-noisy error region)
        //  3. committed AND no errorMsg           → fallback for sites that
        //                                            don't keep their list mounted
        //  4. otherwise                           → fail
        const success =
            priceDropped || (committed && stuck) || (committed && !errorMsg)
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
        return { success, newTotal, committed, errorMsg, errorIsNew }
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
