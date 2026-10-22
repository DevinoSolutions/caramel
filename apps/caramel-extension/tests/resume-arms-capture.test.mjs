import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
import { implOf } from './_trusted-events.mjs'
// The background's side of the per-tab handoffs (see the helper).
const handoffs = tabHandoffBackground()

/**
 * The page load that RESUMES a pending auto-apply submit must still watch for a
 * code the SHOPPER types.
 *
 * On a classic form-POST cart, Caramel's Apply click reloads the page.
 * startCheckoutDetection() then takes the pending-submit record and reports
 * what happened (store-detect.js `_resumePendingSubmit`) and returns early —
 * deliberately: falling through would run tryInitialize() and the SPA observer,
 * which re-prompt "Try Caramel Coupons" as if nothing had happened (the
 * 1800petmeds defect, navigation-handoff.test.mjs). That early return also
 * skipped armCodeCapture(), so on exactly that page load a shopper who typed
 * their own code was never captured (found by a code trace, 2026-10-13).
 *
 * Two groups:
 *   · "pinned (unchanged by the fix)" characterises the resume path as it was
 *     BEFORE the fix and must stay green through it: one final modal, no
 *     re-prompt, no observer, no second auto-apply.
 *   · "capture is armed on the resumed page" is the regression, plus the three
 *     things the fix must not break: Caramel's own verdict is never judged as a
 *     shopper code, arming stays idempotent, and nothing new is started.
 *
 * Every test gets fresh modules (code-capture keeps an `_armed` flag at module
 * scope) and the document-level listeners it attached are removed afterwards,
 * because `document` outlives the module graph.
 */

let finalModalCalls
let promptCalls
let startApplyingCalls
let sent
let couponList

const REC = {
    domain: location.hostname,
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    errorIndicator: '#err',
    successIndicator: '#applied-row',
}

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...args) => {
        startApplyingCalls.push(args)
        return Promise.resolve()
    },
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // Assigned by initCaramelBase(); a spread would freeze it undefined.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
    }
})
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: (...args) => finalModalCalls.push(args),
    insertCaramelPrompt: (...args) => promptCalls.push(args),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
}))

function installChromeStub() {
    const area = () => ({
        get: (_keys, cb) => cb({}),
        set: (_items, cb) => cb && cb(),
        remove: (_keys, cb) => cb && cb(),
    })
    globalThis.chrome = {
        runtime: {
            id: 'test-ext-id',
            lastError: undefined,
            onMessage: { addListener: () => {} },
            sendMessage: (message, cb) => {
                if (handoffs.answers(message, cb)) return
                if (message?.action === 'fetchCoupons') {
                    cb({ coupons: couponList })
                    return
                }
                if (message?.action === 'submitShopperCode') {
                    sent.push(message)
                    cb({ couponId: '1', created: true, status: 'unverified' })
                    return
                }
                cb({})
            },
            getURL: p => p,
        },
        storage: {
            sync: area(),
            local: area(),
            onChanged: { addListener: () => {} },
        },
    }
    globalThis.browser = undefined
    window.chrome = globalThis.chrome
    window.browser = undefined
}

// jsdom marks every script-dispatched event isTrusted=false, the very property
// code-capture keys on. A window-level capture listener runs before the
// module's (document, capture) and flips it on the events a test marks as the
// shopper's. Same device as code-capture.test.mjs.
const _asShopper = new WeakSet()
const trusted = event => {
    _asShopper.add(event)
    return event
}
function flipTrusted(event) {
    if (!_asShopper.has(event)) return
    implOf(event).isTrusted = true
}

function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

const promo = () => document.getElementById('promo')

function shopperTypes(code) {
    promo().value = code
    promo().dispatchEvent(
        trusted(
            new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
        ),
    )
}
const shopperClicksApply = () =>
    document
        .getElementById('apply')
        .dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })))

/** The store answers the shopper's Apply: an applied row naming the code and a
 *  lower total, a moment later, like a real round-trip. */
function storeAcceptsOnApply() {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(() => {
            const row = document.createElement('div')
            row.id = 'applied-row'
            setText(row, `${promo().value} applied`)
            document.body.appendChild(row)
            setText(document.getElementById('total'), 'Order Total $40.00')
        }, 100)
    })
}

const settle = ms => new Promise(r => setTimeout(r, ms))
// The committed path waits ~1.2s for the row to prove it sticks.
const LONG = { timeout: 4000 }

const attached = []
let realAddEventListener
let detect // startCheckoutDetection from the fresh module graph
let markPending
let ready

/** document-level observers code-capture attached this test, by event type. */
const captureListeners = type => attached.filter(([t]) => t === type).length

beforeEach(async () => {
    finalModalCalls = []
    promptCalls = []
    startApplyingCalls = []
    sent = []
    couponList = [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<div id="total"></div><div id="err"></div>'
    setText(document.getElementById('total'), 'Order Total $59.12')
    window.history.replaceState({}, '', '/cart')
    window.__caramel_checkout_observer = null
    // jsdom has no layout: answering through the DOM API _isVisible consults
    // first reaches its callers inside dom-utils too, which a stub cannot.
    Element.prototype.checkVisibility = () => true
    for (const type of ['input', 'click', 'keydown'])
        window.addEventListener(type, flipTrusted, true)

    realAddEventListener = document.addEventListener.bind(document)
    document.addEventListener = (type, fn, capture) => {
        attached.push([type, fn, capture])
        return realAddEventListener(type, fn, capture)
    }

    vi.resetModules()
    installChromeStub()
    const base = await import('../caramel-base.js')
    base.initCaramelBase()
    const dom = await import('../dom-utils.js')
    const storeDetect = await import('../store-detect.js')
    const capture = await import('../code-capture.js')
    storeDetect.getDomainRecord.cache = [REC]
    storeDetect._caramelResetCachedCodes()
    detect = storeDetect.startCheckoutDetection
    markPending = dom.caramelMarkPendingSubmit
    ready = capture.caramelCodeCaptureReady
})

afterEach(() => {
    for (const [type, fn, capture] of attached.splice(0))
        document.removeEventListener(type, fn, capture)
    document.addEventListener = realAddEventListener
    for (const type of ['input', 'click', 'keydown'])
        window.removeEventListener(type, flipTrusted, true)
    window.__caramel_checkout_observer?.disconnect()
    window.__caramel_checkout_observer = null
})

describe('the resume path, pinned (unchanged by the fix)', () => {
    it('reports the outcome once and does not re-prompt', async () => {
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][0]).toBeCloseTo(14.78, 2)
        expect(promptCalls).toEqual([])
    })

    it('leaves the SPA re-detection observer off (the early return stays)', async () => {
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(window.__caramel_checkout_observer).toBeFalsy()
    })

    it('starts no auto-apply when no run is open', async () => {
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(startApplyingCalls).toEqual([])
    })

    it('an ordinary page (no pending submit) still prompts and observes', async () => {
        await detect()

        expect(promptCalls).toHaveLength(1)
        expect(finalModalCalls).toEqual([])
    })
})

describe('capture is armed on the resumed page', () => {
    it('attaches the shopper-gesture observers on the resume page load', async () => {
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(captureListeners('input')).toBe(1)
        expect(captureListeners('click')).toBe(1)
        expect(captureListeners('keydown')).toBe(1)
    })

    it('shares a code the shopper types and the store accepts after the resume', async () => {
        markPending('SALE20', 'c1', [73.9])
        await detect()
        await ready()

        storeAcceptsOnApply()
        shopperTypes('SAVE10')
        shopperClicksApply()

        await vi.waitFor(() => expect(sent).toHaveLength(1), LONG)
        expect(sent[0]).toEqual({
            action: 'submitShopperCode',
            site: location.hostname,
            code: 'SAVE10',
        })
    })

    it("never judges Caramel's own pending verdict as a shopper code", async () => {
        // The resumed submit WON (a saving was reported). With nobody touching
        // the page, nothing may be shared — not the pending code, not anything.
        markPending('SALE20', 'c1', [73.9])
        await detect()
        await ready()
        await settle(1800)

        expect(finalModalCalls).toHaveLength(1)
        expect(sent).toEqual([])
    })

    it('ignores script-driven input and clicks on the resumed page', async () => {
        markPending('SALE20', 'c1', [73.9])
        await detect()
        await ready()

        storeAcceptsOnApply()
        promo().value = 'SALE20'
        promo().dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
        )
        document.getElementById('apply').click()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('stays quiet while a continued run is applying (its overlay is up)', async () => {
        markPending('SALE20', 'c1', [73.9])
        await detect()
        await ready()

        storeAcceptsOnApply()
        // Marked as ours, the way the runner's overlay is (a page element
        // with this id is not our runner).
        const { caramelMarkOwnHost } = await import('../caramel-base.js')
        const overlay = caramelMarkOwnHost(document.createElement('div'))
        overlay.id = 'caramel-testing-overlay'
        document.body.appendChild(overlay)
        shopperTypes('SAVE10')
        shopperClicksApply()
        await settle(1800)

        expect(sent).toEqual([])
    })

    it('does not start an auto-apply of its own', async () => {
        markPending('SALE20', 'c1', [73.9])

        await detect()
        await ready()

        expect(startApplyingCalls).toEqual([])
        expect(promptCalls).toEqual([])
        expect(window.__caramel_checkout_observer).toBeFalsy()
    })

    it('keeps the run continuation: one resumed auto-apply, capture armed once', async () => {
        // An open run with the code unresolved hands over to the runner exactly
        // as before; arming capture adds no second apply.
        const dom = await import('../dom-utils.js')
        await dom.caramelBeginRun()
        setText(document.getElementById('total'), 'Order Total $73.90')
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(startApplyingCalls).toHaveLength(1)
        expect(startApplyingCalls[0][1]).toEqual({ resumed: true })
        expect(captureListeners('input')).toBe(1)
    })

    it('arming is idempotent across the resume pass and a later detection pass', async () => {
        markPending('SALE20', 'c1', [73.9])
        await detect()
        const afterResume = captureListeners('click')

        // The coupon-runner URL-change re-detection calls it again, with no
        // pending record now: the ordinary path arms on every pass.
        await detect()

        expect(afterResume).toBe(1)
        expect(captureListeners('input')).toBe(1)
        expect(captureListeners('click')).toBe(1)
        expect(captureListeners('keydown')).toBe(1)
    })

    it('arms nothing on an unsupported store', async () => {
        const storeDetect = await import('../store-detect.js')
        storeDetect.getDomainRecord.cache = [{ domain: 'not-this-host.test' }]
        markPending('SALE20', 'c1', [73.9])

        await detect()

        expect(captureListeners('input')).toBe(0)
        expect(captureListeners('click')).toBe(0)
    })
})
