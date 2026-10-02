import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

/**
 * code-capture.js — a code the SHOPPER types is shared with Caramel only when
 * the store visibly accepts it.
 *
 * These drive the real module against a real (jsdom) checkout. The "store"
 * answers shortly after the shopper's Apply click: it either shows an applied
 * row and drops the total (accepted) or prints an error (rejected). The
 * background worker is a stub that records every message it is sent, because
 * the contract under test is exactly "which messages leave the page".
 *
 * jsdom marks every script-dispatched event isTrusted=false, which is the very
 * property the module keys on. `trusted()` flips the flag on the event's
 * internal impl so a test can play the part of a real user gesture.
 */

let arm
let ready
let valid
let accepted
let sent
let syncData
let changeListeners

const REC = {
    domain: 'example.com',
    couponInput: 'input',
    couponSubmit: '#apply',
    priceContainer: '#total',
    errorIndicator: '#err',
    successIndicator: '#applied-row',
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
    for (const type of ['click', 'keydown', 'input'])
        window.addEventListener(type, flip, true)
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
    changeListeners = []
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
        storage: {
            sync: area(() => syncData),
            local: area(() => ({})),
            onChanged: { addListener: fn => changeListeners.push(fn) },
        },
    }
}

/** The user changes a setting in the popup: storage fires onChanged. */
function settingsChangeTo(next) {
    syncData.caramel_settings = next
    for (const fn of changeListeners)
        fn({ caramel_settings: { newValue: next } }, 'sync')
}

/** The store reacts to the shopper's Apply: `accept` shows an applied row and
 *  drops the total, else it prints a rejection. Deferred like a real
 *  round-trip. `after` runs inside the answer (e.g. to clear the box). */
function storeAnswers(accept, { after } = {}) {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(() => {
            if (accept) {
                const row = document.createElement('div')
                row.id = 'applied-row'
                setText(row, 'Discount applied')
                document.body.appendChild(row)
                setText(document.getElementById('total'), '$90.00')
            } else {
                setText(document.getElementById('err'), 'This code is invalid')
            }
            after?.()
        }, 100)
    })
}

/** A cart whose total moves with NO applied row: noise, not a coupon. */
function cartTotalDropsOnApply() {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(
            () => setText(document.getElementById('total'), '$90.00'),
            100,
        )
    })
}

const promo = () => document.querySelector('input')

/** What a real shopper does: keystrokes/paste produce trusted insert* input
 *  events, and the field then holds the code. */
function shopperTypes(code, inputType = 'insertText') {
    promo().value = code
    promo().dispatchEvent(
        trusted(new InputEvent('input', { bubbles: true, inputType })),
    )
}

function shopperClicksApply() {
    document
        .getElementById('apply')
        .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })))
}

function shopperPressesEnter() {
    promo().dispatchEvent(
        trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
}

const settle = ms => new Promise(r => setTimeout(r, ms))
// The committed path waits 1.2s for the row to prove it sticks.
const LONG = { timeout: 6000 }

async function armed(rec = REC) {
    expect(arm(rec)).toBe(true)
    await ready()
}

beforeAll(() => {
    installTrustedShim()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

// Every test re-imports the module (fresh state) but `document` outlives it, so
// the previous instance's document-level listeners would keep answering events
// from a stale copy of the settings. Record what each test attaches and detach
// it afterwards.
const attached = []
let realAddEventListener
beforeAll(() => {
    realAddEventListener = document.addEventListener.bind(document)
    document.addEventListener = (type, fn, capture) => {
        attached.push([type, fn, capture])
        return realAddEventListener(type, fn, capture)
    }
})
afterEach(() => {
    for (const [type, fn, capture] of attached.splice(0))
        document.removeEventListener(type, fn, capture)
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
    ready = mod.caramelCodeCaptureReady
    valid = mod.caramelShopperCodeValid
    accepted = mod.caramelCaptureAccepted
})

describe('a shopper-typed code the store accepts', () => {
    it('is sent once, with the hostname and the code', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        expect(sent[0]).toEqual({
            action: 'submitShopperCode',
            site: location.hostname,
            code: 'SAVE10',
        })
    })

    it('is sent when the shopper presses Enter in the box too', async () => {
        await armed()
        // Enter has no button to click: the store reacts to the keydown.
        promo().addEventListener('keydown', () => {
            setTimeout(() => {
                const row = document.createElement('div')
                row.id = 'applied-row'
                setText(row, 'Discount applied')
                document.body.appendChild(row)
            }, 100)
        })
        shopperTypes('SAVE10')
        shopperPressesEnter()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        expect(sent[0].code).toBe('SAVE10')
    })

    it('click plus Enter for the same code is ONE gesture: sent once', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        shopperPressesEnter()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        await settle(500)
        expect(sent).toHaveLength(1)
    })

    it('is sent once per tab even if the shopper applies it again', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)

        shopperClicksApply()
        await settle(1800)

        expect(sent).toHaveLength(1)
    })

    it('is still shared when the store clears the box after accepting', async () => {
        await armed()
        storeAnswers(true, { after: () => (promo().value = '') })
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })

    it('arming twice attaches the observers once (and still sends once)', async () => {
        const spy = vi.spyOn(document, 'addEventListener')
        await armed()
        const attached = spy.mock.calls.length
        expect(arm(REC)).toBe(false)
        expect(spy.mock.calls.length).toBe(attached)
        spy.mockRestore()

        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        await settle(500)
        expect(sent).toHaveLength(1)
    })
})

describe('what must never leave the page', () => {
    it('nothing for a code the store rejects', async () => {
        await armed()
        storeAnswers(false)
        shopperTypes('NOPE123')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing for a bare price drop with no applied row (cart noise)', async () => {
        await armed()
        cartTotalDropsOnApply()
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(1500)

        expect(sent).toEqual([])
    })

    it("nothing for Caramel's own (synthetic) clicks", async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        // The runner clicks with dispatchEvent/.click(): isTrusted is false.
        document.getElementById('apply').click()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing while the runner is applying (its overlay is up)', async () => {
        await armed()
        storeAnswers(true)
        const overlay = document.createElement('div')
        overlay.id = 'caramel-testing-overlay'
        document.body.appendChild(overlay)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing when the runner starts mid-watch', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(30)
        const overlay = document.createElement('div')
        overlay.id = 'caramel-testing-overlay'
        document.body.appendChild(overlay)
        await settle(2200)

        expect(sent).toEqual([])
    })

    it('nothing when the shopper switched sharing off', async () => {
        syncData.caramel_settings = { shareCheckoutCodes: false }
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('with sharing off a gesture does no work at all (no selector queries)', async () => {
        syncData.caramel_settings = { shareCheckoutCodes: false }
        await armed()
        const query = vi.spyOn(document, 'querySelectorAll')
        const evaluate = vi.spyOn(document, 'evaluate')
        shopperTypes('SAVE10')
        shopperClicksApply()
        shopperPressesEnter()
        await settle(300)

        expect(query).not.toHaveBeenCalled()
        expect(evaluate).not.toHaveBeenCalled()
        query.mockRestore()
        evaluate.mockRestore()
    })

    it('nothing when sharing is switched off mid-watch', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(30)
        settingsChangeTo({ shareCheckoutCodes: false })
        await settle(2200)

        expect(sent).toEqual([])
    })

    it('a setting switched back on is honoured for the next gesture', async () => {
        syncData.caramel_settings = { shareCheckoutCodes: false }
        await armed()
        settingsChangeTo({ shareCheckoutCodes: true })
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })

    it('nothing on a site the shopper paused', async () => {
        syncData.caramel_settings = { disabledSites: [location.hostname] }
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('nothing for a string that is not a plausible code', async () => {
        await armed()
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

describe('gift-card and card numbers', () => {
    const FIELD_MARKUP = {
        'its name': el => (el.name = 'giftCardNumber'),
        'its id': el => (el.id = 'gift-card-input'),
        'its placeholder': el => (el.placeholder = 'Gift card or voucher'),
        'its aria-label': el => el.setAttribute('aria-label', 'Loyalty points'),
        'its autocomplete': el => el.setAttribute('autocomplete', 'email'),
        'its label': _el => {
            const label = document.createElement('label')
            label.htmlFor = 'promo'
            label.textContent = 'Enter your reward code'
            document.body.prepend(label)
        },
        'its aria-labelledby text': el => {
            const span = document.createElement('span')
            span.id = 'lbl'
            span.textContent = 'Referral code'
            document.body.prepend(span)
            el.setAttribute('aria-labelledby', 'lbl')
        },
    }

    it.each(Object.keys(FIELD_MARKUP))(
        'a field that says so in %s is never shared',
        async which => {
            FIELD_MARKUP[which](promo())
            await armed()
            storeAnswers(true)
            shopperTypes('SAVE10')
            shopperClicksApply()
            await settle(1800)

            expect(sent).toEqual([])
        },
    )

    it('an ordinary promo field (name, label) is still shared', async () => {
        promo().name = 'discountCode'
        promo().placeholder = 'Discount code'
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })

    it.each([
        ['an 8-digit number', '12345678'],
        ['a 16-digit card number', '4111111111111111'],
        ['a hyphenated card number', '4111-1111-1111-1111'],
    ])('%s typed into a look-alike box is never shared', async (_l, number) => {
        await armed()
        storeAnswers(true)
        shopperTypes(number)
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })
})

describe('only a value the shopper typed', () => {
    it('a store-prefilled value (set by script, no input event) is not shared', async () => {
        await armed()
        storeAnswers(true)
        promo().value = 'PREFILL10'
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('a script-dispatched (untrusted) input event does not count as typing', async () => {
        await armed()
        storeAnswers(true)
        promo().value = 'SCRIPT10'
        promo().dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
        )
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('an autofill / replacement-text input is not the shopper typing', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('AUTOFILL10', 'insertReplacementText')
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('a value typed and then overwritten by script is not shared', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('TYPED10')
        promo().value = 'OVERWRITTEN10'
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('a pasted code counts as typed', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('PASTED10', 'insertFromPaste')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })
})

describe('one verdict, one code', () => {
    it('a superseded watcher is ignored: A is dropped, only B is shared', async () => {
        await armed()
        // Every Apply is answered "accepted" 100ms later, so A's verdict lands
        // after the shopper has already moved on to B.
        storeAnswers(true)
        shopperTypes('CODE-A')
        shopperClicksApply()
        await settle(30)
        shopperTypes('CODE-B')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        await settle(800)
        expect(sent.map(m => m.code)).toEqual(['CODE-B'])
    })

    it('any later gesture supersedes a pending watcher, even one that is itself refused', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('CODE-A')
        shopperClicksApply()
        await settle(30)
        // The shopper tries something that is not a code (refused, no watcher)
        // and then puts A back. The box matches A again when A's verdict lands,
        // so ONLY the generation counter can tell that A is stale.
        shopperTypes('ab')
        shopperClicksApply()
        shopperTypes('CODE-A')
        await settle(2200)

        expect(sent).toEqual([])
    })

    it('a different value in the box when the verdict lands is not shared', async () => {
        await armed()
        storeAnswers(true)
        shopperTypes('CODE-A')
        shopperClicksApply()
        await settle(30)
        // Typed, but not applied: no new gesture, so only the box check stops A.
        shopperTypes('SOMETHING-ELSE')
        await settle(2200)

        expect(sent).toEqual([])
    })
})

describe('what happens after the worker answers', () => {
    it('a skipped answer (e.g. signed out) un-marks the code so it can be resent', async () => {
        const original = globalThis.chrome.runtime.sendMessage
        let answer = { skipped: 'signed-out' }
        globalThis.chrome.runtime.sendMessage = (message, cb) => {
            sent.push(message)
            cb(answer)
        }
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        await settle(100)

        // After sign-in the shopper applies it again: it goes out again.
        answer = { couponId: '1', created: true, status: 'unverified' }
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(2), LONG)
        globalThis.chrome.runtime.sendMessage = original
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

    it('rejects card-shaped codes the server would', () => {
        for (const bad of [
            '12345678',
            '4111111111111111',
            '4111-1111-1111-1111',
            'AB12-3456-7890-1234',
        ])
            expect(valid(bad)).toBeNull()
        expect(valid('1234567')).toBe('1234567')
        expect(valid('SAVE2024')).toBe('SAVE2024')
    })
})

describe('caramelCaptureAccepted', () => {
    it('needs the store to have visibly applied something', () => {
        expect(accepted({ success: true, committed: true })).toBe(true)
        // The runner would take a bare price drop; a capture does not.
        expect(
            accepted({ success: true, committed: false, priceDropped: true }),
        ).toBe(false)
        expect(accepted({ success: false, committed: true })).toBe(false)
        expect(accepted(null)).toBe(false)
    })
})
