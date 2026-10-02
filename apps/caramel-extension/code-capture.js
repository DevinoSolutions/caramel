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
//   · It does not decide whether sharing is allowed: the setting
//     (shareCheckoutCodes) is read here, but the sign-in gate and the server
//     flag live in background.js, so this file stays dumb.
//
// Known limit (documented, not hidden): a classic form-POST cart answers with a
// full page load, which destroys this content script mid-attempt, so there is
// no verdict to read and nothing is captured. The runner's pending-submit
// machinery is for OUR attempts and is intentionally not reused here.
import {
    caramelGetSettings,
    caramelSendMessage,
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

// Per-tab record of codes already shared, so applying the same code twice (or
// click + Enter for one gesture) sends once. sessionStorage: dies with the tab,
// like the tried-codes set.
const SHARED_KEY = 'caramel_shared_codes'
const SHARED_MAX = 50
// How long we wait for the store's first visible answer to the shopper's
// attempt. Longer than the runner's 10s default would only hold the watcher
// open for nothing; the same budget keeps the two judgements comparable.
const VERDICT_TIMEOUT_MS = 10000

/* Codes with a watcher already running. Enter inside the coupon box can also
 * produce a click on the form's submit button, so one gesture may reach us
 * twice; this keeps it to one verdict. */
const _inFlight = new Set()
let _armed = false

// Exported for tests.
export function caramelShopperCodeValid(raw) {
    const code = String(raw ?? '').trim()
    return SHOPPER_CODE_PATTERN.test(code) ? code : null
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
        /* storage blocked — the in-flight set and the server still dedupe */
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

async function _judgeAndShare(rec, code, snapshot) {
    // Started synchronously by the caller, so its baselines predate the store's
    // own handler.
    const verdictPromise = caramelAwaitCouponVerdict(rec, snapshot, {
        code,
        timeoutMs: VERDICT_TIMEOUT_MS,
    })
    const [settings, verdict] = await Promise.all([
        caramelGetSettings(),
        verdictPromise,
    ])
    if (!settings.shareCheckoutCodes) return
    if (!verdict.success) return
    // Re-check after the (up to 10s) wait: a second watcher for the same code,
    // or the shopper pressing Apply again, may have shared it already.
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
    if (_inFlight.has(code.toLowerCase())) return
    const snapshot = caramelSnapshotCart(rec)
    _inFlight.add(code.toLowerCase())
    _judgeAndShare(rec, code, snapshot)
        .catch(err => logError('codeCapture', err))
        .finally(() => _inFlight.delete(code.toLowerCase()))
}

function _onClick(event, rec) {
    if (!event.isTrusted || _runnerIsApplying()) return
    const input = pickBestMatch(rec.couponInput)
    if (!input) return
    const submit = pickBestMatch(rec.couponSubmit, input)
    if (!submit || submit === input) return
    if (!(event.target instanceof Node) || !submit.contains(event.target))
        return
    _consider(rec, input, submit)
}

function _onKeydown(event, rec) {
    if (!event.isTrusted || event.key !== 'Enter' || _runnerIsApplying()) return
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
    if (!code || _alreadyShared(code)) return
    _start(rec, code)
}

/* Attach the observers for this document. Idempotent: store-detect calls it on
 * every detection pass, and the listeners are document-level (capture phase,
 * so they run BEFORE the store's own handlers — which also survives SPA
 * checkouts that re-render the coupon box) and resolve the elements at event
 * time. A record without both selectors has nothing to watch. */
export function armCodeCapture(rec) {
    if (_armed || !rec || !rec.couponInput || !rec.couponSubmit) return false
    _armed = true
    document.addEventListener('click', e => _onClick(e, rec), true)
    document.addEventListener('keydown', e => _onKeydown(e, rec), true)
    return true
}
