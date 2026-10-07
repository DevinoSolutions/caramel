import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    CODE_SHARING_CONSENT_KEY,
    codeSharingAccepted,
    parseCodeSharingConsent,
} from '../code-sharing-consent.js'

/**
 * code-capture.js — a code the SHOPPER types is shared with Caramel only when
 * the store visibly accepts it AND the shopper has explicitly consented.
 *
 * These drive the real module against a real (jsdom) checkout. The "store"
 * answers shortly after the shopper's Apply click: it either shows an applied
 * row and drops the total (accepted) or prints an error (rejected). The
 * background worker is a stub that applies the REAL consent gate
 * (code-sharing-consent.js) and records what it would have let reach the
 * network in `sent`, because the contract under test is exactly "which codes
 * leave the page". Every message the page addressed to it, refused or not, is
 * in `attempts`. (The worker's own gates are pinned against the real
 * background.js in background-shopper-code.test.mjs.)
 *
 * Consent is seeded as ACCEPTED by default — the state the pre-existing
 * behaviour tests describe — and the `consent` describe block below drives the
 * states that matter: no record, a stale legacy `shareCheckoutCodes: true`,
 * declined, dismissed, malformed.
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
let attempts
let workerGate // 'open' | 'signed-out' | 'disabled' — what the worker says first
let syncData
let changeListeners

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const accepted_ = () => ({
    choice: 'accepted',
    at: '2026-10-06T12:00:00.000Z',
    promptVersion: 1,
})
const declined_ = () => ({
    choice: 'declined',
    at: '2026-10-06T12:00:00.000Z',
    promptVersion: 1,
})

/** The worker's gate order (background.js submitShopperCode): signed in, flag
 *  on, THEN consent. Only a code that passes all three counts as `sent`. */
function workerAnswer(message) {
    if (workerGate !== 'open') return { skipped: workerGate }
    const record = parseCodeSharingConsent(syncData[CODE_SHARING_CONSENT_KEY])
    if (!codeSharingAccepted(record)) return { skipped: 'no-consent' }
    sent.push(message)
    return { couponId: '1', created: true, status: 'unverified' }
}

const shareCard = () => document.getElementById('caramel-share-prompt')
const cardButton = id => shareCard().shadowRoot.querySelector(`#${id}`)

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
                attempts.push(message)
                cb(workerAnswer(message))
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

/** The popup (or another tab) writes the consent record: onChanged fires. */
function consentChangeTo(next) {
    syncData[CODE_SHARING_CONSENT_KEY] = next
    for (const fn of changeListeners)
        fn({ [CODE_SHARING_CONSENT_KEY]: { newValue: next } }, 'sync')
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
                setText(row, `${promo().value} applied`)
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
    // The consent card fetches the packaged stylesheets (packaged under public/
    // in the repo, assets/ in the build); serve them from disk.
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () =>
            readFileSync(join(EXT_ROOT, 'public', relPath), 'utf8'),
    })
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
    attempts = []
    workerGate = 'open'
    syncData = { [CODE_SHARING_CONSENT_KEY]: accepted_() }
    vi.resetModules()
    installChromeStub()
    window.currentBrowser = undefined
    const base = await import('../caramel-base.js')
    base.initCaramelBase()
    const mod = await import('../code-capture.js')
    const ui = await import('../UI-helpers.js')
    mod.initCodeCapture({ askConsent: ui.showCodeSharingPrompt })
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
                setText(row, `${promo().value} applied`)
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

    it('nothing for a generic "redeemed" row that does not name the code, with no price drop', async () => {
        await armed()
        document.getElementById('apply').addEventListener('click', () => {
            setTimeout(() => {
                const row = document.createElement('div')
                row.id = 'applied-row'
                setText(row, 'Reward points redeemed')
                document.body.appendChild(row)
            }, 100)
        })
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('a row that names the code (any case) is enough without a price drop', async () => {
        await armed()
        document.getElementById('apply').addEventListener('click', () => {
            setTimeout(() => {
                const row = document.createElement('div')
                row.id = 'applied-row'
                setText(row, 'save10 - coupon applied')
                document.body.appendChild(row)
            }, 100)
        })
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })

    it('nothing when the store applies a row but ALSO prints a new error', async () => {
        await armed()
        storeAnswers(true, {
            after: () =>
                setText(document.getElementById('err'), 'This code is invalid'),
        })
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(1800)

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

    it('nothing when the shopper declined sharing', async () => {
        syncData[CODE_SHARING_CONSENT_KEY] = declined_()
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(600)

        expect(sent).toEqual([])
    })

    it('with sharing declined a gesture does no work at all (no selector queries)', async () => {
        syncData[CODE_SHARING_CONSENT_KEY] = declined_()
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
        consentChangeTo(declined_())
        await settle(2200)

        expect(sent).toEqual([])
        expect(attempts).toEqual([])
    })

    it('sharing switched back on in the popup is honoured for the next gesture', async () => {
        syncData[CODE_SHARING_CONSENT_KEY] = declined_()
        await armed()
        consentChangeTo(accepted_())
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

    it('a setup that throws attaches nothing and leaves a later arm free to retry', async () => {
        const spy = vi.spyOn(document, 'addEventListener')
        const realAdd = globalThis.chrome.storage.onChanged.addListener
        globalThis.chrome.storage.onChanged.addListener = () => {
            throw new Error('no change events in this runtime')
        }
        expect(arm(REC)).toBe(false)
        expect(spy).not.toHaveBeenCalled()

        // The runtime recovers; the next detection pass arms for real.
        globalThis.chrome.storage.onChanged.addListener = realAdd
        await armed()
        expect(spy).toHaveBeenCalled()
        spy.mockRestore()

        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
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
        workerGate = 'signed-out'
        await armed()
        storeAnswers(true)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await vi.waitFor(() => expect(attempts).toHaveLength(1), LONG)
        await settle(100)
        expect(sent).toEqual([])

        // After sign-in the shopper applies it again: it goes out again.
        workerGate = 'open'
        shopperClicksApply()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
    })
})

// The owner rule (2026-10-06): a shopper's code is shared ONLY after an
// explicit, in-extension opt-in. These are the behaviours that make it so.
describe('consent: nothing is sent before the shopper says yes', () => {
    /** The shopper types a code the store accepts. */
    async function shopperAppliesAcceptedCode(code = 'SAVE10') {
        await armed()
        storeAnswers(true)
        shopperTypes(code)
        shopperClicksApply()
    }
    const waitForCard = () =>
        vi.waitFor(() => expect(shareCard()).not.toBeNull(), LONG)

    it('no consent record: the code is NOT sent, and the consent card appears instead', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode()

        await waitForCard()
        await settle(300)
        expect(sent).toEqual([])
        // The page asked the worker once (which refused: no-consent), nothing more.
        expect(attempts).toHaveLength(1)
    })

    it('a stale legacy shareCheckoutCodes:true is NOT consent: no send, a prompt instead', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        syncData.caramel_settings = { shareCheckoutCodes: true }
        await shopperAppliesAcceptedCode()

        await waitForCard()
        expect(sent).toEqual([])
    })

    it.each([
        ['an unknown choice', { choice: 'maybe', at: '2026-10-06T12:00:00Z' }],
        [
            'a record from another prompt version',
            { ...accepted_(), promptVersion: 2 },
        ],
        ['an unparsable date', { ...accepted_(), at: 'yesterday' }],
        ['a bare boolean', true],
        ['a string', 'accepted'],
    ])('%s counts as no record (never as consent)', async (_label, bad) => {
        syncData[CODE_SHARING_CONSENT_KEY] = bad
        await shopperAppliesAcceptedCode()

        await waitForCard()
        expect(sent).toEqual([])
    })

    it('"Share codes" records acceptance and sends the code the card named, once', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()
        expect(sent).toEqual([])

        cardButton('caramel-share-yes').click()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        expect(sent[0]).toEqual({
            action: 'submitShopperCode',
            site: location.hostname,
            code: 'SAVE10',
        })
        expect(syncData[CODE_SHARING_CONSENT_KEY]).toMatchObject({
            choice: 'accepted',
            promptVersion: 1,
        })
        expect(
            Number.isNaN(Date.parse(syncData[CODE_SHARING_CONSENT_KEY].at)),
        ).toBe(false)
        expect(shareCard()).toBeNull()
    })

    it('after acceptance the next code is sent with no second prompt', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()
        cardButton('caramel-share-yes').click()
        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)

        // A different code, in a fresh answer round.
        shopperTypes('SECOND20')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(2), LONG)
        expect(sent[1].code).toBe('SECOND20')
        expect(shareCard()).toBeNull()
    })

    it('"No thanks" records the decline, sends nothing, and never prompts again', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()

        cardButton('caramel-share-no').click()

        await vi.waitFor(
            () =>
                expect(syncData[CODE_SHARING_CONSENT_KEY]?.choice).toBe(
                    'declined',
                ),
            LONG,
        )
        expect(shareCard()).toBeNull()
        expect(sent).toEqual([])

        // The shopper keeps applying codes: no card, and the page does not even
        // bother the worker.
        const askedSoFar = attempts.length
        shopperTypes('SECOND20')
        shopperClicksApply()
        await settle(1800)
        expect(shareCard()).toBeNull()
        expect(attempts).toHaveLength(askedSoFar)
        expect(sent).toEqual([])
    })

    it('dismissing with the close button records NOTHING and asks again next time', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()

        cardButton('caramel-share-close').click()

        await vi.waitFor(() => expect(shareCard()).toBeNull(), LONG)
        expect(CODE_SHARING_CONSENT_KEY in syncData).toBe(false)
        expect(sent).toEqual([])

        // The next code the store accepts brings the question back. (Not the
        // same code again: it is already on the cart, so re-applying it moves
        // nothing and is not a new acceptance.)
        shopperTypes('SECOND20')
        shopperClicksApply()
        await waitForCard()
        expect(sent).toEqual([])
        // Two full capture rounds (each waits out the store's verdict), so it
        // needs more than the 5s default.
    }, 15000)

    it('Escape also dismisses without recording anything', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

        await vi.waitFor(() => expect(shareCard()).toBeNull(), LONG)
        expect(CODE_SHARING_CONSENT_KEY in syncData).toBe(false)
        expect(sent).toEqual([])
    })

    it('a page navigation (the content script just goes away) leaves no record', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()

        // Nothing but the card's own buttons ever write the record, so a card
        // abandoned by navigation has written nothing.
        expect(CODE_SHARING_CONSENT_KEY in syncData).toBe(false)
        expect(sent).toEqual([])
    })

    it('server flag off: no prompt (there is nothing to share)', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        workerGate = 'disabled'
        await shopperAppliesAcceptedCode()

        await vi.waitFor(() => expect(attempts).toHaveLength(1), LONG)
        await settle(300)
        expect(shareCard()).toBeNull()
        expect(sent).toEqual([])
    })

    it('signed out: no prompt (capture needs an account)', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        workerGate = 'signed-out'
        await shopperAppliesAcceptedCode()

        await vi.waitFor(() => expect(attempts).toHaveLength(1), LONG)
        await settle(300)
        expect(shareCard()).toBeNull()
        expect(sent).toEqual([])
    })

    it('no prompt for a code the store rejected', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await armed()
        storeAnswers(false)
        shopperTypes('NOPE123')
        shopperClicksApply()
        await settle(1800)

        expect(shareCard()).toBeNull()
        expect(attempts).toEqual([])
    })

    it('no prompt on a site the shopper paused', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        syncData.caramel_settings = { disabledSites: [location.hostname] }
        await shopperAppliesAcceptedCode()
        await settle(1800)

        expect(shareCard()).toBeNull()
        expect(attempts).toEqual([])
    })

    it('a "yes" that could not be saved sends nothing', async () => {
        delete syncData[CODE_SHARING_CONSENT_KEY]
        await shopperAppliesAcceptedCode('SAVE10')
        await waitForCard()
        const realSet = globalThis.chrome.storage.sync.set
        globalThis.chrome.storage.sync.set = (_items, cb) => {
            globalThis.chrome.runtime.lastError = { message: 'quota exceeded' }
            cb()
            globalThis.chrome.runtime.lastError = undefined
        }

        cardButton('caramel-share-yes').click()
        await settle(600)

        expect(sent).toEqual([])
        expect(CODE_SHARING_CONSENT_KEY in syncData).toBe(false)
        globalThis.chrome.storage.sync.set = realSet
    })

    describe('the card itself', () => {
        async function openCard() {
            delete syncData[CODE_SHARING_CONSENT_KEY]
            await shopperAppliesAcceptedCode('SAVE10')
            await waitForCard()
            return shareCard().shadowRoot
        }

        it('lives in a shadow root and says what is shared, plainly', async () => {
            const root = await openCard()
            const text = root.textContent
            expect(text).toContain(
                'Share this code with other Caramel shoppers?',
            )
            expect(text).toContain('SAVE10')
            expect(text).toContain(
                'Caramel would send only the code and the store, linked to your account to prevent abuse',
            )
            expect(text).toContain('never your cart, order or payment details')
            expect(text).toContain(
                'Shared codes are shown publicly without your name',
            )
            expect(text).toContain(
                'You can change this anytime in Caramel’s settings',
            )
            // Nothing leaked into the page's own DOM.
            expect(shareCard().children.length).toBe(0)
        })

        it('links to the privacy policy', async () => {
            const root = await openCard()
            const link = root.querySelector('#caramel-share-privacy')
            expect(link.getAttribute('href')).toBe(
                'https://grabcaramel.com/privacy',
            )
            expect(link.getAttribute('rel')).toContain('noopener')
        })

        it('"Share codes" and "No thanks" are equals: one class, none pre-selected or focused', async () => {
            const root = await openCard()
            const yes = root.querySelector('#caramel-share-yes')
            const no = root.querySelector('#caramel-share-no')
            expect(yes.textContent).toBe('Share codes')
            expect(no.textContent).toBe('No thanks')
            expect(yes.className).toBe(no.className)
            expect(yes.hasAttribute('autofocus')).toBe(false)
            expect(no.hasAttribute('autofocus')).toBe(false)
            expect(root.activeElement).toBeNull()
            // No per-button override anywhere in the sheet: the two buttons are
            // styled by the shared class alone.
            const css = readFileSync(
                join(EXT_ROOT, 'public/assets/content-ui.css'),
                'utf8',
            )
            expect(css).not.toMatch(/#caramel-share-(yes|no)\b/)
        })

        it('the code is written as text, never parsed as markup', async () => {
            delete syncData[CODE_SHARING_CONSENT_KEY]
            await armed()
            storeAnswers(true)
            // Passes the code pattern (letters/digits/_/-) but proves the path
            // uses textContent: nothing element-like can exist in the card.
            shopperTypes('Img-onerror_1')
            shopperClicksApply()
            await waitForCard()
            const root = shareCard().shadowRoot
            expect(
                root.querySelector('#caramel-share-code-text').textContent,
            ).toBe('Img-onerror_1')
            expect(root.querySelectorAll('img').length).toBe(0)
        })
    })
})

describe('code-sharing-consent record', () => {
    it('parses exactly the documented shape', () => {
        expect(parseCodeSharingConsent(accepted_())).toEqual(accepted_())
        expect(parseCodeSharingConsent(declined_())).toEqual(declined_())
    })

    it('absent or malformed is not consent', () => {
        for (const bad of [
            undefined,
            null,
            {},
            { choice: 'accepted' },
            { ...accepted_(), choice: 'ACCEPTED' },
            { ...accepted_(), at: 123 },
            { ...accepted_(), promptVersion: '1' },
        ])
            expect(codeSharingAccepted(parseCodeSharingConsent(bad))).toBe(
                false,
            )
    })

    it('only an accepted record allows sharing', () => {
        expect(codeSharingAccepted(parseCodeSharingConsent(accepted_()))).toBe(
            true,
        )
        expect(codeSharingAccepted(parseCodeSharingConsent(declined_()))).toBe(
            false,
        )
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
    const OK = {
        success: true,
        committed: true,
        priceDropped: true,
        errorMsg: null,
        errorIsNew: false,
        appliedRowsText: '',
    }

    it('needs the store to have visibly applied something', () => {
        expect(accepted(OK, 'SAVE10')).toBe(true)
        // The runner would take a bare price drop; a capture does not.
        expect(accepted({ ...OK, committed: false }, 'SAVE10')).toBe(false)
        expect(accepted({ ...OK, success: false }, 'SAVE10')).toBe(false)
        expect(accepted(null, 'SAVE10')).toBe(false)
    })

    it('without a price drop, the applied row must name the code (any case)', () => {
        const noDrop = { ...OK, priceDropped: false }
        expect(
            accepted(
                { ...noDrop, appliedRowsText: 'save10 applied' },
                'SAVE10',
            ),
        ).toBe(true)
        expect(
            accepted(
                { ...noDrop, appliedRowsText: 'Discount redeemed' },
                'SAVE10',
            ),
        ).toBe(false)
        expect(accepted({ ...noDrop, appliedRowsText: '' }, 'SAVE10')).toBe(
            false,
        )
    })

    it('refuses a NEW error message even when a row committed', () => {
        expect(
            accepted(
                { ...OK, errorMsg: 'Code invalid', errorIsNew: true },
                'X1Y',
            ),
        ).toBe(false)
        // Stale furniture that was already on the page is not the store's verdict.
        expect(
            accepted(
                { ...OK, errorMsg: 'Code invalid', errorIsNew: false },
                'X1Y',
            ),
        ).toBe(true)
    })
})
