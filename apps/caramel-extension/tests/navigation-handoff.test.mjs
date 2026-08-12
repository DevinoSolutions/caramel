import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    caramelMarkPendingSubmit,
    caramelTakePendingSubmit,
} from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'

// Submitting a promo code on a classic checkout is a form POST: the page
// navigates and takes the content script, the overlay, and everything the run
// knew with it.
//
// 1800petmeds.com (QA sweep 2026-08-05): THEO20 came off the order for a real
// $14.78 and the user was told NOTHING for the ~180s they sat there — the fresh
// document re-inserted the "Try Caramel Coupons" pill as if the extension had
// never run. The money was delivered; the product looked dead.
//
// The fix hands the attempt across the navigation, but carries only what was
// known BEFORE the submit. Whether it worked is measured on the new page. That
// asymmetry is the whole point, and most of what this file pins: a tool that
// treats "we submitted and the page reloaded" as success is a tool that claims
// savings its users never got.

let finalModalCalls
let recordedSavings
let reportedOutcomes

// The store list is seeded into getDomainRecord's own cache now, so the record
// has to be for the host this realm is on. Nothing below reads the domain.
const REC = {
    domain: location.hostname,
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

/* Collaborators the old harness replaced on globalThis are module imports now.
 * Two are replaced through the TRANSPORT instead of a vi.mock:
 *   · the code list — coupon-fetch and store-detect import each other, and a
 *     factory still evaluating the real coupon-fetch is bypassed by
 *     store-detect's own binding (measured while porting), so the codes come
 *     back through the service-worker message fetchCouponsPage actually sends;
 *   · reportOutcome — coupon-runner calls its own copy, so the outcomes are
 *     read off the message the real one posts to the worker. */
let couponList
let probeCartJsonImpl
let applyCouponImpl
vi.mock('../coupon-apply.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        applyCoupon: (...args) =>
            (applyCouponImpl ?? actual.applyCoupon)(...args),
        probeCartJson: (...args) => probeCartJsonImpl(...args),
    }
})
vi.mock('../dom-utils.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // getPrice REASSIGNS this one, so a spread would hand the runner the
        // empty array it held at mock time — and the prices carried across the
        // navigation are the whole subject of this file.
        get _caramelLastPrices() {
            return actual._caramelLastPrices
        },
        // jsdom has no layout, so nothing is ever "visible" and isCheckout
        // would otherwise sit through its 3s grace on every case.
        waitForElement: async () => {
            throw new Error('not found')
        },
        waitUntilReady: async () => {},
    }
})
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // Assigned by initCaramelBase(); a spread would freeze it undefined.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: s => recordedSavings.push(s),
    }
})
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: (...args) => finalModalCalls.push(args),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {
        // Standing in for the defect: before the handoff existed, the fresh
        // page's only response to a completed attempt was to prompt again.
        const pill = document.createElement('div')
        pill.id = 'caramel-small-prompt'
        document.body.appendChild(pill)
    },
}))

function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'fetchCoupons') {
            if (typeof cb === 'function') cb({ coupons: couponList })
            return
        }
        if (message?.action === 'reportOutcome') {
            reportedOutcomes.push({ id: message.id, outcome: message.outcome })
        }
        if (typeof cb === 'function') cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    let el = document.getElementById('total')
    if (!el) {
        el = document.createElement('div')
        el.id = 'total'
        document.body.appendChild(el)
    }
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/cart')
    finalModalCalls = []
    recordedSavings = []
    reportedOutcomes = []

    getDomainRecord.cache = [REC]
    _caramelResetCachedCodes()
    couponList = [
        { code: 'THEO20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    applyCouponImpl = null
    // A cart-shaped URL with a readable cart is what makes isCheckout answer
    // yes here — the old suite said so by stubbing isCheckout itself, which is
    // now called inside its own module and cannot be replaced from outside.
    probeCartJsonImpl = async () => ({
        token: 't',
        total_price: 73.9,
        item_count: 2,
        currency: 'USD',
    })
})

describe('dom-utils.js — the pending-submit record', () => {
    it('round-trips the code, its id, and the prices seen before submitting', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9, 59.12])

        expect(caramelTakePendingSubmit()).toEqual({
            code: 'THEO20',
            id: 'c1',
            prices: [73.9, 59.12],
        })
    })

    it('records no outcome at all — only what was known before the submit', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        const stored = JSON.parse(
            sessionStorage.getItem('caramel_pending_submit'),
        )

        expect(stored).not.toHaveProperty('saved')
        expect(stored).not.toHaveProperty('success')
    })

    it('is consumed on read, so an attempt is announced once and not again', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        expect(caramelTakePendingSubmit()).not.toBeNull()
        expect(caramelTakePendingSubmit()).toBeNull()
    })

    it('ignores a record from a visit the user has moved on from', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        expect(caramelTakePendingSubmit(0)).toBeNull()
    })

    it('survives blocked storage without throwing', () => {
        expect(() =>
            caramelMarkPendingSubmit('THEO20', 'c1', [Number.NaN]),
        ).not.toThrow()
        // NaN is not JSON — it would have deserialised as null and poisoned the
        // baseline maths, so it never gets stored in the first place.
        expect(caramelTakePendingSubmit().prices).toEqual([])
    })
})

describe('coupon-runner.js — the record is written before the submit', () => {
    // If it were written after, the navigating case — the only case it exists
    // for — would never write one at all.
    const RUNNER_REC = { ...REC }

    beforeEach(() => {
        document.body.innerHTML =
            '<input id="promo" /><button id="apply">Apply</button>'
        setTotalText('Order Total $73.90')
        globalThis._caramelCancelled = false
        couponList = [{ code: 'THEO20', id: 'c1' }]
        probeCartJsonImpl = async () => null // non-Shopify: DOM path
        // jsdom has no layout, so _isVisible falls back to offsetParent and
        // answers no for everything. Answering through the DOM API it consults
        // reaches its callers INSIDE dom-utils too, which a module stub cannot.
        Element.prototype.checkVisibility = () => true
    })

    it('has the attempt on record while the code is in flight', async () => {
        let inFlight = null
        applyCouponImpl = async () => {
            // Stands in for the form POST: this is the moment the real page
            // navigates and this content script stops existing.
            inFlight = caramelTakePendingSubmit()
            return {
                success: false,
                newTotal: 73.9,
                committed: false,
                errorMsg: null,
            }
        }

        await startApplyingCoupons(RUNNER_REC)

        expect(inFlight).not.toBeNull()
        expect(inFlight.code).toBe('THEO20')
        expect(inFlight.id).toBe('c1')
        expect(inFlight.prices).toContain(73.9)
    })

    it('leaves nothing behind when the attempt returns normally', async () => {
        applyCouponImpl = async () => ({
            success: false,
            newTotal: 73.9,
            committed: false,
            errorMsg: null,
        })

        await startApplyingCoupons(RUNNER_REC)

        expect(caramelTakePendingSubmit()).toBeNull()
    })
})

describe('store-detect.js — the page after the navigation', () => {
    it('reports a measured win instead of leaving the user in silence', async () => {
        // $73.90 before, $59.12 after: the real 1800petmeds numbers.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(finalModalCalls).toHaveLength(1)
        const [amount, code] = finalModalCalls[0]
        expect(amount).toBeCloseTo(14.78, 2)
        expect(code).toBe('THEO20')
    })

    it('banks the measured win and credits the coupon', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(recordedSavings).toHaveLength(1)
        expect(recordedSavings[0].amount).toBeCloseTo(14.78, 2)
        expect(recordedSavings[0].code).toBe('THEO20')
        expect(reportedOutcomes).toEqual([{ id: 'c1', outcome: 'worked' }])
    })

    it('does not re-prompt as if the attempt had never happened', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(document.getElementById('caramel-small-prompt')).toBeNull()
    })

    it('claims nothing when the total did not move', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        const [amount, code, message] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/hasn't changed/i)
        expect(recordedSavings).toEqual([])
    })

    it('does not blame the coupon for a page that navigated', async () => {
        // The runner's rule, held here too: only the store's own rejection
        // words count as evidence against a code.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        expect(reportedOutcomes).toEqual([])
    })

    it('offers the OTHER codes, not the one that just failed to move it', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        const list = finalModalCalls[0][4] ?? []
        expect(list.map(c => c.code)).toEqual(['SPRING10'])
    })

    it('says it cannot tell, rather than guessing, when nothing is readable', async () => {
        // No price on the page at all — the case where treating "submitted +
        // reloaded" as success would invent a saving.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        await startCheckoutDetection()

        const [amount, code, message] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/check your order summary/i)
        expect(recordedSavings).toEqual([])
        expect(reportedOutcomes).toEqual([])
    })

    it('never turns a price RISE into a saving', async () => {
        // Shipping added after the reload: the tightest-baseline rule has no
        // candidate at or above the new total, so there is no figure to claim.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $81.40')

        await startCheckoutDetection()

        expect(finalModalCalls[0][0]).toBe(0)
        expect(recordedSavings).toEqual([])
    })

    it('leaves an ordinary page alone when no attempt was interrupted', async () => {
        // Guards the guard: with no pending record the fresh-page path must go
        // back to normal detection, not swallow it.
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        expect(finalModalCalls).toEqual([])
        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })
})
