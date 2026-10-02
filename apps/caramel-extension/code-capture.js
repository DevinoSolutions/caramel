// owns: shopper-typed code capture (armCodeCapture, caramelShopperCodeValid) — when the SHOPPER types a promo code and presses the store's own Apply (or Enter), judge the store's answer with the same snapshot/verdict rule applyCoupon uses and, ONLY if the store accepted it, hand {site, code} to the worker for POST /api/coupons/submit.
//
// ES module (WXT). store-detect.js calls armCodeCapture(rec) once it holds the
// store record; nothing here runs at module scope.
//
// What this deliberately is NOT:
//   · It never types, clicks or submits anything. It only watches the
//     shopper's own gestures, so it cannot place or alter an order.
//   · It never reads the cart, the order or payment details. The only data that
//     leaves the page is the store's hostname and the code the shopper typed.
//   · It does not decide whether the user is signed in or whether the server
//     flag is on: those gates live in background.js. The per-user switch
//     (shareCheckoutCodes) and the per-site pause ARE enforced here, from an
//     in-memory copy kept fresh by storage change events, so that with sharing
//     off a gesture costs nothing at all (no snapshot, no polling, no query).
//
// What must never be shared, and how each is stopped:
//   · A gift-card / card / email / loyalty number typed into a look-alike box:
//     the field's own name/label text is checked (_fieldLooksLikeAPromoBox),
//     and the code's SHAPE is refused (looksLikeCardNumber, mirrored with the
//     server, which refuses it too).
//   · A value the shopper did not type (store prefill, browser autofill, a
//     script): only a trusted `input` event with an insert* inputType counts,
//     and the field must still hold exactly that value at gesture time.
//   · A verdict about a DIFFERENT code than the one now in the box: every
//     gesture bumps a generation counter and a watcher whose generation is no
//     longer current discards its answer.
//   · Noise from our own runner or from the cart changing for other reasons: a
//     capture needs a committed result AND either a real price drop or an applied
//     row that names the typed code, and is refused when a fresh error appears.
//
// Known limit (documented, not hidden): a classic form-POST cart answers with a
// full page load, which destroys this content script mid-attempt, so there is
// no verdict to read and nothing is captured. The runner's pending-submit
// machinery is for OUR attempts and is intentionally not reused here.
import {
    caramelGetSettings,
    caramelOnSettingsChanged,
    caramelSendMessage,
    caramelSiteIsPaused,
    log,
    logError,
} from './caramel-base.js'
import {
    caramelAwaitCouponVerdict,
    caramelSnapshotCart,
} from './coupon-apply.js'
import {
    caramelFormSubmitIsUnsafe,
    caramelIsForbiddenControl,
    pickBestMatch,
} from './dom-utils.js'

// MIRROR of SHOPPER_CODE_PATTERN in apps/caramel-app/src/lib/shopperCoupons.ts,
// which is the source of truth (the server re-validates). The extension cannot
// import app code, so the pattern is copied and
// apps/caramel-app/tests/unit/shopper-code-pattern-mirror.test.ts fails if the
// two ever differ.
const SHOPPER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/

// MIRROR of looksLikeCardNumber in the same app file (same drift guard, which
// rebuilds THIS function from its source text and compares behaviour). Keep it
// self-contained: no references outside its own body.
function looksLikeCardNumber(code) {
    if (/^[0-9]{8,}$/.test(code)) return true
    const digits = code.replace(/[^0-9]/g, '').length
    return code.length >= 16 && digits >= 12
}

// The input's own words (name, id, placeholder, aria-label, autocomplete, its
// <label>) say it is not a promo box. A gift-card box that also matched the
// store's coupon selector would otherwise leak a card number.
const NON_PROMO_FIELD =
    /gift|card|voucher|loyalty|reward|points|referral|e-?mail/i

// A click can only be on the Apply control if the target sits in something
// interactive. Cheap `closest` check run BEFORE any selector query.
const CLICKABLE =
    'button, a, input, label, [role="button"], [type="submit"], [tabindex]'

// Per-tab record of codes already shared, so applying the same code twice (or
// click + Enter for one gesture) sends once. sessionStorage: dies with the tab,
// like the tried-codes set.
const SHARED_KEY = 'caramel_shared_codes'
const SHARED_MAX = 50
// How long we wait for the store's first visible answer to the shopper's
// attempt. Longer than the runner's 10s default would only hold the watcher
// open for nothing; the same budget keeps the two judgements comparable.
const VERDICT_TIMEOUT_MS = 10000

let _armed = false
// In-memory copy of the two user choices that gate capture, null until the
// first read lands (gestures are ignored until then: fail closed).
let _prefs = null
let _prefsFromEvent = false
let _prefsReady = Promise.resolve()
// One number per qualifying gesture. A watcher compares its own against this
// when its verdict lands; a stale one is discarded.
let _generation = 0
// The watcher for the CURRENT generation: { generation, code }.
let _current = null
// Last value the shopper really typed (or pasted) into each field.
const _typed = new WeakMap()

// Exported for tests.
export function caramelShopperCodeValid(raw) {
    const code = String(raw ?? '').trim()
    if (!SHOPPER_CODE_PATTERN.test(code)) return null
    return looksLikeCardNumber(code) ? null : code
}

// The capture's acceptance rule. The runner's success rule also takes a bare
// price drop or any new row, but a shopper's cart can move or grow rows for
// reasons that are not the code (quantity edits, shipping estimates,
// auto-discounts, a generic "redeemed" banner), and a share is irreversible. So
// a capture needs ALL of: the store visibly applied a row (`committed`); that
// row is tied to THIS code, either by the total dropping or by the row's own
// text naming the code (case-insensitive); and no NEW error text beside it.
// Exported for tests.
export function caramelCaptureAccepted(verdict, code) {
    if (!verdict || verdict.success !== true || verdict.committed !== true)
        return false
    if (verdict.errorMsg && verdict.errorIsNew) return false
    const rowNamesCode =
        !!code &&
        String(verdict.appliedRowsText ?? '')
            .toLowerCase()
            .includes(String(code).toLowerCase())
    return verdict.priceDropped === true || rowNamesCode
}

// Exported for tests: resolves when the first settings read has landed.
export function caramelCodeCaptureReady() {
    return _prefsReady
}

function _applySettings(settings) {
    _prefs = {
        share: settings.shareCheckoutCodes,
        paused: caramelSiteIsPaused(settings.disabledSites, location.hostname),
    }
}

function _captureOn() {
    return !!_prefs && _prefs.share && !_prefs.paused
}

function _sharedKeyFor(code) {
    return `${location.hostname.toLowerCase()}|${code.toLowerCase()}`
}

function _alreadyShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) && list.includes(_sharedKeyFor(code))
    } catch {
        // Unreadable or blocked storage: treat as "not shared yet". The server
        // dedupes the same code per store anyway, so the cost is one request.
        return false
    }
}

function _markShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        const next = (Array.isArray(list) ? list : []).filter(
            k => k !== _sharedKeyFor(code),
        )
        next.push(_sharedKeyFor(code))
        sessionStorage.setItem(
            SHARED_KEY,
            JSON.stringify(next.slice(-SHARED_MAX)),
        )
    } catch {
        /* storage blocked — the generation check and the server still dedupe */
    }
}

function _unmarkShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        if (!Array.isArray(list)) return
        sessionStorage.setItem(
            SHARED_KEY,
            JSON.stringify(list.filter(k => k !== _sharedKeyFor(code))),
        )
    } catch {
        /* storage blocked — nothing was recorded to undo */
    }
}

/* Our own apply loop is running (its overlay is up). The loop's events are
 * synthetic and already fail isTrusted, but a shopper clicking inside the page
 * while it runs muddies every reading the loop takes — not a moment to judge
 * anything. */
function _runnerIsApplying() {
    return !!document.getElementById('caramel-testing-overlay')
}

function _fieldLooksLikeAPromoBox(input) {
    const parts = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute('aria-label'),
        input.getAttribute('autocomplete'),
    ]
    for (const label of Array.from(input.labels ?? []))
        parts.push(label.textContent)
    const labelledBy = input.getAttribute('aria-labelledby')
    if (labelledBy) {
        for (const id of labelledBy.split(/\s+/))
            parts.push(document.getElementById(id)?.textContent)
    }
    return !NON_PROMO_FIELD.test(parts.filter(Boolean).join(' '))
}

// The field now holds the judged code, or nothing: some stores clear the box
// once a code is applied, and an empty box says nothing against the verdict. A
// DIFFERENT value means the verdict may be about something else.
function _fieldStillHolds(rec, code) {
    const value = (pickBestMatch(rec.couponInput)?.value ?? '').trim()
    return value === '' || value === code
}

function _stillCurrent(rec, code, generation) {
    return (
        generation === _generation &&
        !_runnerIsApplying() &&
        _captureOn() &&
        _fieldStillHolds(rec, code)
    )
}

async function _judgeAndShare(rec, code, snapshot, generation) {
    // Started synchronously by the caller, so its baselines predate the store's
    // own handler. `redact`: the shopper's code never reaches a log line.
    const verdict = await caramelAwaitCouponVerdict(rec, snapshot, {
        code,
        timeoutMs: VERDICT_TIMEOUT_MS,
        redact: true,
    })
    // Re-checked after the (up to 10s) wait: the shopper may have moved on to
    // another code, our runner may have started, or sharing may have been
    // switched off.
    if (!_stillCurrent(rec, code, generation)) return
    if (!caramelCaptureAccepted(verdict, code)) return
    if (_alreadyShared(code)) return
    _markShared(code)
    let resp
    try {
        resp = await caramelSendMessage({
            action: 'submitShopperCode',
            site: location.hostname,
            code,
        })
    } catch (err) {
        _unmarkShared(code)
        logError('submitShopperCode', err)
        return
    }
    if (resp?.skipped) {
        // signed-out / disabled / daily-limit etc.: an expected, quiet outcome.
        // Unmarked so the same code can go out once the cause clears (sign-in).
        _unmarkShared(code)
        log('SHOPPER_CODE_SKIPPED', { reason: resp.skipped })
        return
    }
    if (resp?.error) {
        _unmarkShared(code)
        logError('submitShopperCode', resp.error)
        return
    }
    log('SHOPPER_CODE_SHARED', { created: resp?.created })
}

function _start(rec, code) {
    const snapshot = caramelSnapshotCart(rec)
    const generation = _generation
    _current = { generation, code }
    _judgeAndShare(rec, code, snapshot, generation)
        .catch(err => logError('codeCapture', err))
        .finally(() => {
            if (_current?.generation === generation) _current = null
        })
}

function _onInput(event) {
    if (!_captureOn() || !event.isTrusted) return
    const inputType = String(event.inputType ?? '')
    // insertReplacementText is how browsers report autofill and spellcheck
    // swaps: not the shopper typing this code.
    if (
        !inputType.startsWith('insert') ||
        inputType === 'insertReplacementText'
    )
        return
    if (event.target instanceof HTMLInputElement)
        _typed.set(event.target, event.target.value.trim())
}

function _onClick(event, rec) {
    if (!_captureOn() || !event.isTrusted || _runnerIsApplying()) return
    if (!(event.target instanceof Element) || !event.target.closest(CLICKABLE))
        return
    const input = pickBestMatch(rec.couponInput)
    if (!input) return
    const submit = pickBestMatch(rec.couponSubmit, input)
    if (!submit || submit === input) return
    if (!submit.contains(event.target)) return
    _consider(rec, input, submit)
}

function _onKeydown(event, rec) {
    if (!_captureOn() || !event.isTrusted || event.key !== 'Enter') return
    if (!(event.target instanceof HTMLInputElement) || _runnerIsApplying())
        return
    const input = pickBestMatch(rec.couponInput)
    if (!input || event.target !== input) return
    _consider(rec, input, input)
}

function _consider(rec, input, control) {
    // Observation only, but a config that points at an order-completing control
    // would make "the store accepted it" meaningless — same refusals as the
    // runner.
    if (
        caramelIsForbiddenControl(control) ||
        caramelFormSubmitIsUnsafe(control)
    )
        return
    const code = caramelShopperCodeValid(input.value)
    // Enter in the box can also click the form's submit button: the same
    // gesture reaching us twice, not a new attempt.
    if (code && _current?.code === code) return
    // A new gesture: whatever a previous watcher was about to say is stale,
    // even when this one is then refused below.
    _generation++
    _current = null
    if (!code || !_fieldLooksLikeAPromoBox(input)) return
    // Only what the shopper typed (or pasted) into this very field.
    if (_typed.get(input) !== code) return
    if (_alreadyShared(code)) return
    _start(rec, code)
}

/* Attach the observers for this document. Idempotent: store-detect calls it on
 * every detection pass, and the listeners are document-level (capture phase,
 * so they run BEFORE the store's own handlers — which also survives SPA
 * checkouts that re-render the coupon box) and resolve the elements at event
 * time. A record without both selectors has nothing to watch. If the runtime
 * cannot tell us the user's choice changed, nothing is attached: a stale
 * "sharing is on" is the one failure that cannot be allowed. */
export function armCodeCapture(rec) {
    if (_armed || !rec || !rec.couponInput || !rec.couponSubmit) return false
    try {
        caramelOnSettingsChanged(settings => {
            _prefsFromEvent = true
            _applySettings(settings)
        })
    } catch (err) {
        logError('codeCapture', err)
        return false
    }
    _prefsReady = caramelGetSettings().then(settings => {
        if (!_prefsFromEvent) _applySettings(settings)
    })
    document.addEventListener('input', _onInput, true)
    document.addEventListener('click', e => _onClick(e, rec), true)
    document.addEventListener('keydown', e => _onKeydown(e, rec), true)
    // Only now: a setup that threw above leaves nothing attached AND leaves the
    // next detection pass free to try again.
    _armed = true
    return true
}
