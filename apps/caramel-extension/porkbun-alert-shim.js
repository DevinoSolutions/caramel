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
// a refused code raises TWO dialogs; a code that WORKS can raise one too, when
// the second POST finds the coupon already on the cart.
//
// WHAT IT DOES: while the submission came from a script (an untrusted click or
// keydown inside the coupon modal), that one message is written into the modal
// as visible text instead of opening a dialog. The store config's
// errorIndicator then points at `#caramel-porkbun-coupon-rejection`, and the
// ordinary verdict path reads the refusal like any other store's error text.
//
// WHAT IT DELIBERATELY DOES NOT DO: touch a shopper's own submission (trusted
// events never arm it, and any trusted click/keydown in the modal disarms it),
// touch any other alert on the site, or stay armed (it lapses after
// PORKBUN_ARM_WINDOW_MS, longer than the store's POST ever takes).

const PORKBUN_MODAL_SELECTOR = '#modal_applyCouponCode'
export const PORKBUN_REJECTION_ID = 'caramel-porkbun-coupon-rejection'
// The one message Porkbun's processApplyCartCoupon alerts when the API answers
// status != 1. Anything else (a session expiry, a network alert) stays native.
const PORKBUN_REJECTION_RE = /unable to apply the coupon/i
export const PORKBUN_ARM_WINDOW_MS = 20000

/* Intercepts `win.alert` for scripted coupon submissions. Returns a function
 * that restores the page's own alert and removes the listeners (tests; the
 * content script lives as long as the page and never calls it). */
export function installPorkbunAlertShim(win) {
    const doc = win.document
    const nativeAlert = win.alert
    let armedAt = null

    function inModal(event) {
        const target = event.target
        return !!target?.closest?.(PORKBUN_MODAL_SELECTOR)
    }

    // Capture phase: runs before the page's inline onclick/onkeydown, so the
    // stale message is gone before this attempt's POST can answer.
    function onSubmitIntent(event) {
        if (!inModal(event)) return
        doc.getElementById(PORKBUN_REJECTION_ID)?.remove()
        armedAt = event.isTrusted ? null : Date.now()
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
    return function uninstall() {
        win.alert = nativeAlert
        doc.removeEventListener('click', onSubmitIntent, true)
        doc.removeEventListener('keydown', onSubmitIntent, true)
    }
}
