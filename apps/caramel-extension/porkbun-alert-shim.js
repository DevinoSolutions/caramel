// owns: Porkbun's native coupon-failure alert() (PORKBUN_*, installPorkbunAlertShim).
//
// Runs in the PAGE's own world (entrypoints/porkbun-alert.content.ts,
// world: 'MAIN'), never in the content-script realm: an alert() is looked up on
// the page's `window`, and a content script's `window.alert = …` assigns to its
// own isolated copy, which the page never calls.
//
// WHY THIS EXISTS (porkbun.com, measured live 2026-10-15): the checkout
// reports a refused coupon with a NATIVE `alert("We were unable to apply the
// coupon. …")`, not with text in the DOM. A native dialog blocks the whole
// renderer until a person dismisses it, so a run that tries N codes would stop
// N times and wait for the shopper each time. Worse, apply-flow submits by
// click AND by an Enter keydown (coupon-apply.js applyCoupon), and Porkbun's
// modal wires both to processApplyCartCoupon, so every attempt POSTs twice and
// a refused code raises TWO dialogs. For a code that WORKS the second POST
// finds the coupon already on the cart and is refused: its message must not be
// read as the verdict on a code the first POST accepted.
//
// WHAT IT DOES, for a submission a script made (an untrusted click inside the
// coupon modal):
//   1. drops the duplicate Enter keydown the apply flow sends right after its
//      click, so the attempt POSTs once and a working code is never answered
//      by a second, refusing POST;
//   2. writes that one refusal message into the modal as visible text instead
//      of opening a dialog. The store config's errorIndicator then points at
//      `#caramel-porkbun-coupon-rejection`, and the ordinary verdict path reads
//      the refusal like any other store's error text.
//
// WHAT IT DELIBERATELY DOES NOT DO: touch a shopper's own submission (trusted
// events never arm it, and any trusted click/keydown in the modal disarms it),
// touch any other alert on the site, or stay armed (it lapses after
// PORKBUN_ARM_WINDOW_MS, longer than the store's POST ever takes). Only a
// shopper's click or Enter in the modal counts as them taking over; a Tab or a
// held modifier does not disturb a run in flight.

import { CARAMEL_CAPABILITY_MARKERS } from './extension-capabilities.js'

const PORKBUN_MODAL_SELECTOR = '#modal_applyCouponCode'
export const PORKBUN_REJECTION_ID = 'caramel-porkbun-coupon-rejection'
// The one message Porkbun's processApplyCartCoupon alerts when the API answers
// status != 1. Anything else (a session expiry, a network alert) stays native.
const PORKBUN_REJECTION_RE = /unable to apply the coupon/i
export const PORKBUN_ARM_WINDOW_MS = 20000
// The apply flow dispatches its Enter in the same tick as its click; this is
// slack for a slow main thread, not a window anyone else's Enter falls into.
export const PORKBUN_DUPLICATE_ENTER_MS = 1500

/* Intercepts `win.alert` for scripted coupon submissions. Returns a function
 * that restores the page's own alert and removes the listeners (tests; the
 * content script lives as long as the page and never calls it). */
export function installPorkbunAlertShim(win) {
    const doc = win.document
    const nativeAlert = win.alert
    let armedAt = null
    let scriptedClickAt = null

    function inModal(event) {
        return !!event.target?.closest?.(PORKBUN_MODAL_SELECTOR)
    }

    function clearRejection() {
        doc.getElementById(PORKBUN_REJECTION_ID)?.remove()
    }

    // Capture phase: runs before the page's inline onclick/onkeydown, so the
    // stale message is gone before this attempt's POST can answer.
    function onSubmitIntent(event) {
        if (!inModal(event)) return
        const isClick = event.type === 'click'
        if (event.isTrusted) {
            // The shopper takes over only by submitting; a Tab or a modifier
            // must not wipe a verdict the apply flow has not read yet.
            if (isClick || event.key === 'Enter') {
                clearRejection()
                armedAt = null
            }
            return
        }
        if (
            !isClick &&
            scriptedClickAt !== null &&
            Date.now() - scriptedClickAt < PORKBUN_DUPLICATE_ENTER_MS
        ) {
            // Same submission, second trigger: let the click's POST stand alone.
            event.stopImmediatePropagation()
            event.preventDefault()
            return
        }
        clearRejection()
        armedAt = Date.now()
        scriptedClickAt = isClick ? armedAt : null
    }

    function showRejection(message) {
        let el = doc.getElementById(PORKBUN_REJECTION_ID)
        if (!el) {
            el = doc.createElement('p')
            el.id = PORKBUN_REJECTION_ID
            el.className = 'text-danger'
            el.setAttribute('role', 'alert')
            const host = doc.querySelector(
                `${PORKBUN_MODAL_SELECTOR} .modal-body`,
            )
            ;(host ?? doc.body).appendChild(el)
        }
        el.textContent = String(message)
    }

    win.alert = function caramelPorkbunAlert(message) {
        const armed =
            armedAt !== null && Date.now() - armedAt < PORKBUN_ARM_WINDOW_MS
        if (armed && PORKBUN_REJECTION_RE.test(String(message))) {
            showRejection(message)
            return undefined
        }
        return nativeAlert.apply(this, arguments)
    }

    doc.addEventListener('click', onSubmitIntent, true)
    doc.addEventListener('keydown', onSubmitIntent, true)

    // Tell the content realm the helper is live (extension-capabilities.js).
    // The proof has to be that this script runs in the PAGE's world, because
    // the DOM is shared and a stamp from the isolated world would be a lie: in
    // a browser that ignores `world: 'MAIN'` this very code still runs, its
    // wrapper just lands on a private copy of `alert` that the page never
    // calls. Only the page's world can see the page's own handler, so the
    // marker waits for it. Tried when parsing finishes and again at load (the
    // handler may come from a late script); stamping is idempotent.
    const marker = CARAMEL_CAPABILITY_MARKERS.alertShim
    const stampIfInPageWorld = () => {
        if (typeof win.processApplyCartCoupon === 'function')
            doc.documentElement.setAttribute(marker, '1')
    }
    if (doc.readyState === 'loading')
        doc.addEventListener('DOMContentLoaded', stampIfInPageWorld)
    else stampIfInPageWorld()
    win.addEventListener('load', stampIfInPageWorld)

    return function uninstall() {
        win.alert = nativeAlert
        doc.removeEventListener('DOMContentLoaded', stampIfInPageWorld)
        win.removeEventListener('load', stampIfInPageWorld)
        doc.documentElement?.removeAttribute(marker)
        doc.removeEventListener('click', onSubmitIntent, true)
        doc.removeEventListener('keydown', onSubmitIntent, true)
    }
}
