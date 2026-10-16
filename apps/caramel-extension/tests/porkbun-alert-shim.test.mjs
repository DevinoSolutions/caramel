import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelIsForbiddenControl } from '../dom-utils.js'
import {
    PORKBUN_ARM_WINDOW_MS,
    PORKBUN_REJECTION_ID,
    installPorkbunAlertShim,
} from '../porkbun-alert-shim.js'

// porkbun.com reports a refused coupon with a NATIVE alert(), which freezes the
// tab until a person dismisses it (measured live 2026-10-15, T-2480). The shim
// turns that one message into visible text inside the coupon modal, but only
// for a submission a SCRIPT made; a shopper's own click keeps the store's
// dialog. The markup below is Porkbun's real coupon modal, trimmed.

const REFUSAL =
    "We were unable to apply the coupon. It may be already applied, it is expired, or the domain or action doesn't qualify for this discount (price too low, premium domain, renewal vs registration, etc)."

let nativeAlert
let uninstall

function mountModal() {
    document.body.innerHTML = `
        <div id="modal_applyCouponCode" class="modal">
            <div class="modal-body">
                <label for="cartCouponCode">coupon code</label>
                <input id="cartCouponCode" type="text" />
            </div>
            <div class="modal-footer">
                <button class="btn btn-porkbun-white btn-lg" data-dismiss="modal">Cancel</button>
                <button id="update" class="btn btn-porkbun btn-lg">Update Cart</button>
            </div>
        </div>
        <button id="elsewhere">Elsewhere</button>`
}

/** What the store's own inline handler does on a refused answer. */
function storeRefuses() {
    window.alert(REFUSAL)
}

function scriptedClick(el) {
    // Untrusted, exactly like el.click() from the apply flow.
    el.click()
}

function rejectionText() {
    return document.getElementById(PORKBUN_REJECTION_ID)?.textContent ?? null
}

beforeEach(() => {
    nativeAlert = vi.fn()
    window.alert = nativeAlert
    mountModal()
    uninstall = installPorkbunAlertShim(window)
})

afterEach(() => {
    uninstall()
    vi.useRealTimers()
})

describe('scripted submission inside the coupon modal', () => {
    it('writes the refusal into the modal instead of opening a dialog', () => {
        scriptedClick(document.getElementById('update'))
        storeRefuses()

        expect(nativeAlert).not.toHaveBeenCalled()
        expect(rejectionText()).toBe(REFUSAL)
        expect(
            document
                .querySelector('#modal_applyCouponCode .modal-body')
                .contains(document.getElementById(PORKBUN_REJECTION_ID)),
        ).toBe(true)
    })

    it('swallows the second dialog of a click-plus-Enter double submit and keeps ONE message', () => {
        const input = document.getElementById('cartCouponCode')
        scriptedClick(document.getElementById('update'))
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                keyCode: 13,
                bubbles: true,
            }),
        )
        storeRefuses()
        storeRefuses()

        expect(nativeAlert).not.toHaveBeenCalled()
        expect(
            document.querySelectorAll(`#${PORKBUN_REJECTION_ID}`),
        ).toHaveLength(1)
    })

    it('clears the previous code’s refusal when the next attempt starts', () => {
        scriptedClick(document.getElementById('update'))
        storeRefuses()
        expect(rejectionText()).toBe(REFUSAL)

        scriptedClick(document.getElementById('update'))

        expect(rejectionText()).toBeNull()
    })

    it('lapses: a refusal long after the submission is the store’s own to show', () => {
        vi.useFakeTimers()
        scriptedClick(document.getElementById('update'))
        vi.advanceTimersByTime(PORKBUN_ARM_WINDOW_MS + 1)
        storeRefuses()

        expect(nativeAlert).toHaveBeenCalledTimes(1)
        expect(rejectionText()).toBeNull()
    })

    it('leaves every other alert native, even while armed', () => {
        scriptedClick(document.getElementById('update'))
        window.alert('Your session has expired.')

        expect(nativeAlert).toHaveBeenCalledWith('Your session has expired.')
        expect(rejectionText()).toBeNull()
    })
})

describe('what it must not touch', () => {
    it('a script click OUTSIDE the modal does not arm it', () => {
        scriptedClick(document.getElementById('elsewhere'))
        storeRefuses()

        expect(nativeAlert).toHaveBeenCalledTimes(1)
    })

    it('never armed at all: the refusal stays native', () => {
        storeRefuses()

        expect(nativeAlert).toHaveBeenCalledTimes(1)
        expect(rejectionText()).toBeNull()
    })

    // The trusted-event branch (a shopper's own click or Enter disarms the
    // shim) cannot be driven here: isTrusted is an unforgeable own property and
    // jsdom mints no trusted events. It is exercised with real input in the
    // browser check recorded on the PR.

    it('uninstall restores the page’s own alert', () => {
        uninstall()
        expect(window.alert).toBe(nativeAlert)
        // afterEach calls uninstall again; it must be idempotent.
    })
})

describe('the apply button is safe to drive', () => {
    it('"Update Cart" is not an order-completing control', () => {
        expect(
            caramelIsForbiddenControl(document.getElementById('update')),
        ).toBe(false)
    })
})
