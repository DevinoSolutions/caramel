import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { caramelBeginRun, caramelMarkPendingSubmit } from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'

// A run on a box the promo-box finder picked carries across a form-POST cart's
// reload just like a configured run does. On a cart that reloads per submit,
// one click otherwise tests ONE code: the first code (often a dead one) uses
// the click and the code that would have worked is never tried.
//
// The finder's pick does not survive the reload, so the run goes on only where
// the finder sees a box on the page the store sent us to, and the resumed run
// finds it again. Every other bound (hops, clock, cancel, tried codes) is the
// run record's own and is pinned in run-continuity.test.mjs.

let applyCalls
let finalModalCalls
let couponList

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...args) => applyCalls.push(args),
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
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
        if (typeof cb !== 'function') return
        if (message?.action === 'fetchCoupons') cb({ coupons: couponList })
        else if (message?.action === 'couponBoxDiscoveryEnabled')
            cb({ enabled: true })
        else cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

const BOX =
    '<div class="promo"><input id="pc" name="promo_code" type="text">' +
    '<button id="ap" type="button">Apply</button></div>'
const TOTAL =
    '<div class="row"><span>Order total</span> <span>$100.00</span></div>'
const ROW = { kind: 'total', label: 'order total', rows: 1 }

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    // jsdom computes no innerText; the finder reads rows by it.
    Object.defineProperty(globalThis.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return this.textContent
        },
    })
})

beforeEach(() => {
    sessionStorage.clear()
    history.replaceState({}, '', '/cart')
    applyCalls = []
    finalModalCalls = []
    // jsdom has no layout: every element is shown, with a size.
    Element.prototype.checkVisibility = () => true
    Element.prototype.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 120,
        bottom: 30,
        width: 120,
        height: 30,
    })
    // No config row for this store: the finder is the only way in.
    getDomainRecord.cache = []
    _caramelResetCachedCodes()
    couponList = [
        { code: 'DEAD5', id: 'c1' },
        { code: 'SAVE10', id: 'c2' },
    ]
})

describe('a finder run on a cart that reloads per code', () => {
    it('goes on to the next code on the page the store sent us to', async () => {
        document.body.innerHTML = BOX + TOTAL
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toHaveLength(1)
        expect(applyCalls[0][0].domain).toBe(location.hostname)
        expect(applyCalls[0][1]).toEqual({ resumed: true })
        expect(finalModalCalls).toEqual([])
    })

    it('stops where the finder sees no box on the new page', async () => {
        document.body.innerHTML = TOTAL
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
        // The codes are still handed over to copy on a store with no config.
        expect(finalModalCalls[0][4].map(c => c.code)).toEqual(['SAVE10'])
    })

    it('stops where it cannot read the total, which may be hiding a win', async () => {
        // The store renamed the row on the new page: the code may well have
        // worked, and the next code submitted onto this cart could replace it.
        document.body.innerHTML =
            BOX +
            '<div class="row"><span>Estimated total</span> <span>$90.00</span></div>'
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('ends on a win instead of going on', async () => {
        document.body.innerHTML =
            BOX +
            '<div class="row"><span>Order total</span> <span>$90.00</span></div>'
        caramelBeginRun()
        caramelMarkPendingSubmit('SAVE10', 'c2', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls[0][0]).toBeCloseTo(10, 2)
    })
})
