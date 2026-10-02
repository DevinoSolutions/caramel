import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * code-capture.js — a code the SHOPPER types is shared with Caramel only when
 * the store visibly accepts it.
 *
 * These drive the real module against a real (jsdom) checkout. The "store"
 * answers one tick after the shopper's Apply click: either the total drops
 * (accepted) or an error appears (rejected). The background worker is a stub
 * that records every message it is sent, because the contract under test is
 * exactly "which messages leave the page".
 *
 * jsdom marks every script-dispatched event isTrusted=false, which is the very
 * property the module keys on. `trusted()` flips the flag on the event's
 * internal impl so a test can play the part of a real user gesture.
 */

let arm
let valid
let sent
let syncData

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    errorIndicator: '#err',
}

function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

// dispatchEvent() resets isTrusted to false (per spec), so the flag cannot be
// set before dispatch. A window-level capture listener runs before ours
// (document, capture) and flips it on the events a test marked as the shopper's.
const _asShopper = new WeakSet()
function trusted(event) {
    _asShopper.add(event)
    return event
}
function installTrustedShim() {
    const flip = event => {
        if (!_asShopper.has(event)) return
        const impl =
            event[
                Object.getOwnPropertySymbols(event).find(s =>
                    String(s).includes('impl'),
                )
            ]
        impl.isTrusted = true
    }
    window.addEventListener('click', flip, true)
    window.addEventListener('keydown', flip, true)
}

function installChromeStub() {
    const area = data => ({
        get: (_keys, cb) => cb({ ...data() }),
        set: (items, cb) => {
            Object.assign(data(), items)
            if (cb) cb()
        },
        remove: (_keys, cb) => cb && cb(),
    })
    globalThis.chrome = {
        runtime: {
            id: 'test-ext-id',
            lastError: undefined,
            onMessage: { addListener: () => {} },
            sendMessage: (message, cb) => {
                sent.push(message)
                cb({ ok: true })
            },
            getURL: p => p,
        },
        storage: { sync: area(() => syncData), local: area(() => ({})) },
    }
}

/** The store reacts to the shopper's Apply: `accept` drops the total, else it
 *  prints a rejection. Deferred a tick like a real round-trip. */
function storeAnswers(accept) {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(() => {
            if (accept) setText(document.getElementById('total'), '$90.00')
            else setText(document.getElementById('err'), 'This code is invalid')
        }, 100)
    })
}

function shopperTypes(code) {
    document.getElementById('promo').value = code
}

function shopperClicksApply() {
    document
        .getElementById('apply')
        .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })))
}

const settle = ms => new Promise(r => setTimeout(r, ms))

beforeAll(() => {
    installTrustedShim()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(async () => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<div id="total"></div><div id="err"></div>'
    setText(document.getElementById('total'), '$100.00')
    sessionStorage.clear()
    sent = []
    syncData = {}
    vi.resetModules()
    installChromeStub()
    window.currentBrowser = undefined
    const base = await import('../caramel-base.js')
    base.initCaramelBase()
    const mod = await import('../code-capture.js')
    arm = mod.armCodeCapture
    valid = mod.caramelShopperCodeValid
})

describe('a shopper-typed code the store accepts', () => {
    it('is sent once, with the hostname and the code', async () => {
        arm(REC)
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toEqual({
            action: 'submitShopperCode',
            site: location.hostname,
            code: 'SAVE10',
        })
    })

    it('is sent when the shopper presses Enter in the box too', async () => {
        arm(REC)
        storeAnswers(true)
        // Enter has no button to click: the store reacts to the keydown.
        document.getElementById('promo').addEventListener('keydown', () => {
            setTimeout(
                () => setText(document.getElementById('total'), '$90.00'),
                100,
            )
        })
        shopperTypes('SAVE10')
        document.getElementById('promo').dispatchEvent(
            trusted(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                }),
            ),
        )

        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0].code).toBe('SAVE10')
    })

    it('is sent once per tab even if the shopper applies it again', async () => {
        arm(REC)
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1))

        setText(document.getElementById('total'), '$100.00')
        shopperClicksApply()
        await settle(500)

        expect(sent).toHaveLength(1)
    })
})

describe('what must never leave the page', () => {
    it('nothing for a code the store rejects', async () => {
        arm(REC)
        storeAnswers(false)
        shopperTypes('NOPE123')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it("nothing for Caramel's own (synthetic) clicks", async () => {
        arm(REC)
        storeAnswers(true)
        shopperTypes('SAVE10')
        // The runner clicks with dispatchEvent/.click(): isTrusted is false.
        document.getElementById('apply').click()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing while the runner is applying (its overlay is up)', async () => {
        arm(REC)
        storeAnswers(true)
        const overlay = document.createElement('div')
        overlay.id = 'caramel-testing-overlay'
        document.body.appendChild(overlay)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing when the shopper switched sharing off', async () => {
        syncData.caramel_settings = { shareCheckoutCodes: false }
        arm(REC)
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing for a string that is not a plausible code', async () => {
        arm(REC)
        storeAnswers(true)
        shopperTypes('a b')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('attaches no listeners for a store with no coupon selectors', () => {
        const spy = vi.spyOn(document, 'addEventListener')
        expect(arm({ domain: 'example.com', couponInput: '#promo' })).toBe(
            false,
        )
        expect(arm({ domain: 'example.com' })).toBe(false)
        expect(spy).not.toHaveBeenCalled()
    })
})

describe('caramelShopperCodeValid', () => {
    it('trims and accepts the server pattern, preserving case', () => {
        expect(valid('  Save-10_x ')).toBe('Save-10_x')
        expect(valid('a'.repeat(40))).toBe('a'.repeat(40))
    })

    it('rejects what the server would', () => {
        for (const bad of ['', 'ab', 'a b', '-ABC', '<script>', 'a'.repeat(41)])
            expect(valid(bad)).toBeNull()
    })
})
