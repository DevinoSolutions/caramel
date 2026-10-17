import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { caramelBeginRun, caramelMarkPendingSubmit } from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// The store's own page can read and write its sessionStorage. What one of our
// documents leaves for the next one — the code submitted before a reload, the
// saving a discount-link win carries across its reload, the run that goes on
// to the next code — decides what is reported as having worked, what saving
// is recorded, and whether codes are submitted without the shopper clicking.
// None of it may come from storage the page can write. Each case below plants
// the record a page could have planted, in the shape the extension once read,
// and pins that it changes nothing. Each has a control beside it, through the
// extension's own handoff, so "nothing happened" cannot pass by the flow
// simply never running.

const handoffs = tabHandoffBackground()

let finalModalCalls
let recordedSavings
let reportedOutcomes
let applyCalls
let couponList

const REC = {
    domain: location.hostname,
    couponInput: '#promo',
    priceContainer: '#total',
}

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    // A continued run is the whole subject of one case: record it rather than
    // drive the apply loop.
    startApplyingCoupons: async (...args) => applyCalls.push(args),
}))
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
    insertCaramelPrompt: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
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
        if (handoffs.answers(message, cb)) return
        if (message?.action === 'reportOutcome')
            reportedOutcomes.push({ id: message.id, outcome: message.outcome })
        if (typeof cb !== 'function') return
        cb(message?.action === 'fetchCoupons' ? { coupons: couponList } : {})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

// What the store's page can do: write its own sessionStorage.
const pageWrites = (key, value) =>
    sessionStorage.setItem(key, JSON.stringify(value))

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = '<input id="promo" /><div id="total"></div>'
    setTotalText('Order Total $59.12')
    window.history.replaceState({}, '', '/cart')
    finalModalCalls = []
    recordedSavings = []
    reportedOutcomes = []
    applyCalls = []
    // jsdom has no layout; answer through the DOM API _isVisible consults first.
    Element.prototype.checkVisibility = () => true
    getDomainRecord.cache = [REC]
    _caramelResetCachedCodes()
    couponList = [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
})

describe('a pending submit the page wrote', () => {
    it('reports no code as having worked and records no saving', async () => {
        pageWrites('caramel_pending_submit', {
            code: 'MADEUP',
            id: 'c-any',
            prices: [1000],
            t: Date.now(),
            finder: false,
        })

        await startCheckoutDetection()

        expect(reportedOutcomes).toEqual([])
        expect(recordedSavings).toEqual([])
        expect(finalModalCalls).toEqual([])
    })

    it('control: the extension’s own pending submit is still read', async () => {
        await caramelMarkPendingSubmit('SALE20', 'c1', [73.9])

        await startCheckoutDetection()

        expect(reportedOutcomes).toEqual([{ id: 'c1', outcome: 'worked' }])
        expect(recordedSavings).toHaveLength(1)
        expect(recordedSavings[0].amount).toBeCloseTo(14.78, 2)
    })
})

describe('a discount-link win the page wrote', () => {
    it('records no saving and shows no result', async () => {
        pageWrites('caramel_applied', {
            code: 'MADEUP',
            id: 'c-any',
            saved: 500,
            currency: 'USD',
            t: Date.now(),
        })

        await startCheckoutDetection()

        expect(recordedSavings).toEqual([])
        expect(finalModalCalls).toEqual([])
    })

    it('control: the extension’s own win is still recorded once', async () => {
        await handoffs.put('applied', {
            code: 'SALE20',
            id: 'c1',
            saved: 8,
            currency: 'USD',
            t: Date.now(),
        })

        await startCheckoutDetection()

        expect(recordedSavings).toEqual([
            {
                domain: location.hostname,
                code: 'SALE20',
                amount: 8,
                currency: 'USD',
                couponId: 'c1',
            },
        ])
        expect(await handoffs.peek('applied')).toBeNull()
    })
})

describe('a run the page wrote', () => {
    it('submits no further code', async () => {
        // The extension's own attempt, on a cart whose total did not move.
        await caramelMarkPendingSubmit('SALE20', 'c1', [59.12])
        pageWrites('caramel_run', { hops: 0, t: Date.now() })

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
    })

    it('control: a run the shopper started still goes on', async () => {
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [59.12])

        await startCheckoutDetection()

        expect(applyCalls).toHaveLength(1)
    })
})
