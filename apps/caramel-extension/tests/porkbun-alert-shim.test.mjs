import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelIsForbiddenControl } from '../dom-utils.js'
import {
    PORKBUN_ARM_WINDOW_MS,
    PORKBUN_DUPLICATE_ENTER_MS,
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

    it('drops the duplicate Enter the apply flow sends right after its click', () => {
        const input = document.getElementById('cartCouponCode')
        const reachedStore = vi.fn()
        input.addEventListener('keydown', reachedStore)
        scriptedClick(document.getElementById('update'))
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 13,
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(enter)

        // The store's own onkeydown (here a stand-in listener) never saw it,
        // so the attempt POSTs once.
        expect(reachedStore).not.toHaveBeenCalled()
        expect(enter.defaultPrevented).toBe(true)
        // Still armed by the click: the one refusal is shown as text.
        storeRefuses()
        expect(nativeAlert).not.toHaveBeenCalled()
        expect(rejectionText()).toBe(REFUSAL)
    })

    it('an Enter that comes alone, or long after the click, is a submission of its own', () => {
        vi.useFakeTimers()
        const input = document.getElementById('cartCouponCode')
        const reachedStore = vi.fn()
        input.addEventListener('keydown', reachedStore)
        const enter = () =>
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            })

        input.dispatchEvent(enter())
        expect(reachedStore).toHaveBeenCalledTimes(1)
        storeRefuses()
        expect(nativeAlert).not.toHaveBeenCalled()

        scriptedClick(document.getElementById('update'))
        vi.advanceTimersByTime(PORKBUN_DUPLICATE_ENTER_MS + 1)
        input.dispatchEvent(enter())
        expect(reachedStore).toHaveBeenCalledTimes(2)
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

    it('uninstall restores the page’s own alert and removes the listeners', () => {
        uninstall()
        expect(window.alert).toBe(nativeAlert)

        scriptedClick(document.getElementById('update'))
        storeRefuses()
        expect(nativeAlert).toHaveBeenCalledTimes(1)
        expect(rejectionText()).toBeNull()
    })
})

// jsdom mints no trusted events and isTrusted cannot be redefined, so the
// shopper-takes-over branch is driven by calling the registered capture
// handlers directly with trusted-shaped events. (A real trusted click is
// exercised against the live site and recorded on the PR.)
describe('a shopper’s own input', () => {
    let handlers
    let uninstallFake

    beforeEach(() => {
        uninstall()
        handlers = []
        const spy = vi
            .spyOn(document, 'addEventListener')
            .mockImplementation((type, fn) => handlers.push([type, fn]))
        uninstallFake = installPorkbunAlertShim(window)
        spy.mockRestore()
    })

    afterEach(() => {
        uninstallFake()
        // The outer afterEach calls the first uninstall again; keep it valid.
        uninstall = () => {}
    })

    function fire(type, init) {
        const event = {
            type,
            target: document.getElementById('update'),
            isTrusted: false,
            ...init,
        }
        for (const [t, fn] of handlers) if (t === type) fn(event)
    }

    it('a trusted click disarms the shim and clears the old message, keeping the dialog', () => {
        fire('click', { isTrusted: false })
        storeRefuses()
        expect(rejectionText()).toBe(REFUSAL)

        fire('click', { isTrusted: true })
        storeRefuses()

        expect(nativeAlert).toHaveBeenCalledTimes(1)
        expect(rejectionText()).toBeNull()
    })

    it('a trusted Enter takes over too', () => {
        fire('click', { isTrusted: false })
        fire('keydown', { isTrusted: true, key: 'Enter' })
        storeRefuses()

        expect(nativeAlert).toHaveBeenCalledTimes(1)
    })

    it('a trusted Tab or modifier does not wipe a run in flight', () => {
        fire('click', { isTrusted: false })
        storeRefuses()
        fire('keydown', { isTrusted: true, key: 'Tab' })
        fire('keydown', { isTrusted: true, key: 'Shift' })

        expect(rejectionText()).toBe(REFUSAL)
        storeRefuses()
        expect(nativeAlert).not.toHaveBeenCalled()
    })

    it('a scripted Enter alone arms the shim (the keydown listener is live)', () => {
        fire('keydown', { isTrusted: false, key: 'Enter' })
        storeRefuses()

        expect(nativeAlert).not.toHaveBeenCalled()
        expect(rejectionText()).toBe(REFUSAL)
    })
})

describe('the apply button is safe to drive', () => {
    it('"Update Cart" is not an order-completing control', () => {
        expect(
            caramelIsForbiddenControl(document.getElementById('update')),
        ).toBe(false)
    })
})
