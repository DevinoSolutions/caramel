// owns: coupon-apply engine — generic selectors, input/error detection, applyCoupon, discount-link fallback (GENERIC_* selectors, setInputValue, removeAppliedCoupon, detectCouponError, applyCoupon, probeCartJson, applyViaDiscountLink)
// load after: caramel-base.js, dom-utils.js, store-detect.js

// Generic selectors used when the per-store config doesn't specify them.
// These cover the most common Honey-style cart UIs.
const GENERIC_APPLIED_SELECTORS =
    '[class*="coupon-applied" i], [class*="discount-applied" i], ' +
    '[class*="cart-coupon-list" i] li, [class*="applied-coupon" i], ' +
    '[class*="coupon-list-item" i], [class*="redeemed" i]'
const GENERIC_REMOVE_SELECTORS =
    '[class*="cart-coupon-list" i] li button, [class*="coupon-list-item" i] button, ' +
    '[class*="applied-coupon" i] button, [aria-label*="Remove" i], ' +
    '[aria-label*="Delete" i], button[title*="Remove" i]'
const GENERIC_ERROR_TEXT_RE =
    /\b(invalid|expired|not\s+(valid|applicable|eligible)|limited\s+to|cannot\s+be\s+(applied|redeemed)|doesn'?t\s+apply|no\s+eligible|enter\s+a\s+valid|nicht|ungültig)\b/i

function findAppliedSelector(rec) {
    return rec.successIndicator || GENERIC_APPLIED_SELECTORS
}
function findRemoveSelector(rec) {
    return rec.couponRemove || GENERIC_REMOVE_SELECTORS
}

// Set value on a (possibly React-controlled) input + fire input/change events.
function setInputValue(input, code) {
    const proto = window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(input, code)
    else input.value = code
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

// Try to remove the most-recently-applied coupon. Returns true if a remove
// button was clicked. Caller should wait for the cart to update.
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
async function removeAppliedCoupon(rec) {
    // Prefer per-config remove; fall back to generic.
    const sel = findRemoveSelector(rec)
    // qAll (not raw querySelectorAll) so an XPath couponRemove selector is
    // evaluated correctly instead of throwing a SyntaxError that aborts removal.
    const candidates = qAll(sel).filter(b => _isVisible(b) && !b.disabled)
    if (candidates.length) {
        // The newest applied coupon is usually rendered last → click last one.
        const btn = candidates[candidates.length - 1]
        btn.click()
        await sleep(600)
        log('Removed applied coupon via', sel)
        return true
    }
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

/* --------------------------------------------------  coupon attempt */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it) and from
// scripts/test-extension.mjs's Playwright harness.
// oxlint-disable-next-line no-unused-vars
async function applyCoupon(code, rec) {
    const attemptStart = performance.now()
    log('AUTO_INSERT_ATTEMPT_START', code, { t: attemptStart })
    recordTiming('AUTO_INSERT_ATTEMPT_START', { code })
    try {
        /* 1] dismiss popup if present */
        if (rec.dismissButton) {
            const btn = qOne(rec.dismissButton)
            if (btn) {
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
            if (showBtn) {
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

        // Snapshot DOM signals BEFORE we apply, so we can compare after.
        const appliedSel = findAppliedSelector(rec)
        const beforeAppliedNodes = qAll(appliedSel).length
        const errorBaseline = snapshotErrorState(rec)

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
        // Always dispatch Enter on the input — harmless when no submit handler,
        // but lets sites that listen to keydown="Enter" pick it up.
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                bubbles: true,
            }),
        )

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
        const afterAppliedNodes = qAll(appliedSel).length
        const committed = afterAppliedNodes > beforeAppliedNodes
        let stuck = false
        if (committed) {
            await sleep(1200)
            const stuckCount = qAll(appliedSel).length
            stuck = stuckCount > beforeAppliedNodes
        }
        const errorMsg = detectCouponError(rec, errorBaseline, code)
        let newTotal = NaN
        let priceDropped = false
        if (hasPriceCfg) {
            newTotal = getPrice(rec.priceContainer, { returnLargest: true })
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
        return { success, newTotal, committed, errorMsg }
    } catch (err) {
        console.error('applyCoupon error', err)
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
        return { success: false, committed: false, errorMsg: String(err) }
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
async function probeCartJson() {
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
function _getTriedCodes() {
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
function _markTriedCode(code) {
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
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
async function applyViaDiscountLink(code) {
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
