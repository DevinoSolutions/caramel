import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelMarkOwnHost, initCaramelBase } from '../caramel-base.js'
import { _markTriedCode } from '../coupon-apply.js'
import {
    caramelBeginRun,
    caramelCancelRun,
    caramelClaimRunHop,
    caramelEndRun,
    caramelHoldAppliedWin,
    caramelMarkPendingSubmit,
} from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
// The background's side of the per-tab handoffs (see the helper).
const handoffs = tabHandoffBackground()

// One click should test more than one code.
//
// On a classic form-POST cart, submitting a promo code is a full page load, so
// exactly ONE code gets tried per click. motoin.de and proaudiostar.com both
// work this way: 20 codes in the list means 20 clicks and 20 reloads, roughly
// ten seconds each, to do what a single click does on a Shopify cart. Nobody
// finishes that — and the codes nobody reaches are the untried ones, because the
// sink deliberately puts those last.
//
// A run now carries across the navigation. That means submitting real codes to
// a real merchant without the shopper clicking again, so the bounds are the
// interesting part, and they are what most of this file pins:
//
//   · the record only ever exists because someone clicked
//   · six hops, three minutes, whichever ends first
//   · every hop must consume a code, and the tried-set survives the reload too
//   · × and Esc end the chain — _caramelCancelled itself dies with the document
//   · no coupon box on the page we landed on → no hop spent on it
//
// A win ends it immediately. So does the loop finishing on one page: a record
// left open would let some unrelated later navigation resume a run that already
// had its answer.

let applyCalls
let finalModalCalls
let hideTestingModalImpl
let startApplyingCouponsImpl

// The store list is seeded into getDomainRecord's own cache now, so the record
// has to be for the host this realm is on. Nothing below reads the domain.
const REC = {
    domain: location.hostname,
    couponInput: '#promo',
    priceContainer: '#total',
}

// The run record the background holds for this tab.
const runRecord = () => handoffs.peek('run')

/* Collaborators the old harness replaced on globalThis are module imports now,
 * replaced in the module the resumed run reads them from. The code list is the
 * exception: coupon-fetch and store-detect import each other, and a vi.mock
 * factory still evaluating the real coupon-fetch is bypassed by store-detect's
 * own binding — so the codes arrive through the service-worker message
 * fetchCouponsPage really sends. */
let couponList
vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...args) => startApplyingCouponsImpl(...args),
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
    insertCaramelPrompt: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => hideTestingModalImpl(),
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
        if (typeof cb !== 'function') return
        cb(message?.action === 'fetchCoupons' ? { coupons: couponList } : {})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = '<input id="promo" />'
    applyCalls = []
    finalModalCalls = []
    // jsdom has no layout, so _isVisible falls back to offsetParent and answers
    // no for every element. Answering through the DOM API it consults first
    // reaches its callers INSIDE dom-utils too, which a module stub cannot.
    Element.prototype.checkVisibility = () => true
    getDomainRecord.cache = [REC]
    _caramelResetCachedCodes()
    couponList = [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    hideTestingModalImpl = () => {}
    startApplyingCouponsImpl = async (...args) => applyCalls.push(args)
})

describe('the run record', () => {
    it('is opened once, so a second page cannot restart the clock', async () => {
        await caramelBeginRun()
        const first = await runRecord()
        await caramelBeginRun()

        expect(await runRecord()).toEqual(first)
    })

    it('does not exist until somebody starts a run', async () => {
        expect(await caramelClaimRunHop()).toBeNull()
    })

    it('counts every hop it hands out', async () => {
        await caramelBeginRun()

        expect((await caramelClaimRunHop()).hops).toBe(1)
        expect((await caramelClaimRunHop()).hops).toBe(2)
    })

    it('stops handing out hops at the cap', async () => {
        await caramelBeginRun()
        const claimed = []
        for (let i = 0; i < 10; i++) claimed.push(await caramelClaimRunHop())

        expect(claimed.filter(Boolean).length).toBe(6)
        expect(claimed[6]).toBeNull()
    })

    it('counts the hop even if the caller gives up afterwards', async () => {
        // The increment is written inside the claim for exactly this reason —
        // a caller that returns early must not get a free retry.
        await caramelBeginRun()
        await caramelClaimRunHop()

        expect((await runRecord()).hops).toBe(1)
    })

    it('expires a chain that has been running too long', async () => {
        await caramelBeginRun()
        await handoffs.put('run', { hops: 0, t: Date.now() - 181000 })

        expect(await caramelClaimRunHop()).toBeNull()
        expect(await runRecord()).toBeNull()
    })

    it('ends for good once cancelled', async () => {
        await caramelBeginRun()
        await caramelCancelRun()

        expect(await caramelClaimRunHop()).toBeNull()
    })

    it('lets the shopper start again after they cancelled', async () => {
        // The cancelled record is a tombstone — hops pinned at the cap. Reading
        // it as "a run is already in flight" would mean one × silenced
        // continuation for the rest of the tab: press the pill again,
        // deliberately, and you are back to one code per reload with no way out
        // short of closing the tab. Pressing the pill IS the consent this runs
        // on, so it starts a fresh run.
        await caramelBeginRun()
        await caramelCancelRun()

        await caramelBeginRun()

        expect((await runRecord()).hops).toBe(0)
        expect((await caramelClaimRunHop()).hops).toBe(1)
    })

    it('does not restart the clock on a run that is merely mid-flight', async () => {
        // The guard above must not become "every page reopens the run", which
        // would make the hop cap meaningless.
        await caramelBeginRun()
        await caramelClaimRunHop()
        await caramelClaimRunHop()

        await caramelBeginRun()

        expect((await runRecord()).hops).toBe(2)
    })

    it('starts clean over an unreadable record rather than building on it', async () => {
        await caramelBeginRun()
        await handoffs.put('run', 'not json')

        await caramelBeginRun()

        expect((await runRecord()).hops).toBe(0)
    })

    it('does not resurrect a run that was never open', async () => {
        // Cancelling with nothing in flight must not write a record that a
        // later page would then have to reason about.
        await caramelCancelRun()

        expect(await runRecord()).toBeNull()
    })

    it('forgets a corrupted record instead of trusting it', async () => {
        await caramelBeginRun()
        await handoffs.put('run', 'not json')

        expect(await caramelClaimRunHop()).toBeNull()
        expect(await runRecord()).toBeNull()
    })

    it('is gone after it ends', async () => {
        await caramelBeginRun()
        await caramelEndRun()

        expect(await runRecord()).toBeNull()
        expect(await caramelClaimRunHop()).toBeNull()
    })
})

describe('picking the loop back up after the store navigated', () => {
    it('carries on with the next code instead of asking for another click', async () => {
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toHaveLength(1)
        expect(applyCalls[0][1]).toEqual({ resumed: true })
    })

    it('leaves an attempt to the loop that is still running it', async () => {
        // The address bar moved (a SPA cart) while our own loop is applying on
        // this same document: re-detection runs, and the attempt the loop is in
        // the middle of is not a reload's leftover.
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])
        await caramelHoldAppliedWin({ code: 'SALE20', id: 'c1', saved: 5 })
        // Marked as ours, the way the runner's overlay is (a page element
        // with this id is not our runner).
        const overlay = caramelMarkOwnHost(document.createElement('div'))
        overlay.id = 'caramel-testing-overlay'
        document.body.appendChild(overlay)

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toEqual([])
        expect(await handoffs.peek('pending_submit')).toMatchObject({
            code: 'SALE20',
        })
        expect(await handoffs.peek('applied')).toMatchObject({ saved: 5 })
        expect((await runRecord()).hops).toBe(0)

        // Once the loop is done, the next page picks it up as before.
        overlay.remove()
        await startCheckoutDetection()
        expect(finalModalCalls).toHaveLength(1)
    })

    it('says nothing terminal while it is still working', async () => {
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(finalModalCalls).toEqual([])
    })

    it('spends a hop each time it continues', async () => {
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect((await runRecord()).hops).toBe(1)
    })

    it('reports the outcome instead when no run is open', async () => {
        // A single-shot apply the user never asked to chain.
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('will not continue on a page with no promo box', async () => {
        // The shopper navigated themselves. Submitting codes into a product
        // page would spend the chain on nothing.
        document.body.innerHTML = '<div>Product page</div>'
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('will not spend a reload on codes it has already tried', async () => {
        await caramelBeginRun()
        _markTriedCode('SALE20')
        _markTriedCode('SPRING10')
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('stops when the shopper pressed × on the previous page', async () => {
        // The whole reason cancellation is written down: the × they clicked was
        // on a document the navigation then destroyed.
        await caramelBeginRun()
        await caramelCancelRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
    })

    it('stops once the hops are spent', async () => {
        await handoffs.put('run', { hops: 6, t: Date.now() })
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('still tells the shopper something if the resumed run throws', async () => {
        // Otherwise they are left behind an "Applying…" overlay with nothing
        // coming — the silence this whole handoff exists to end.
        let hidden = false
        hideTestingModalImpl = () => {
            hidden = true
        }
        startApplyingCouponsImpl = async () => {
            throw new Error('boom')
        }
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(hidden).toBe(true)
        expect(finalModalCalls).toHaveLength(1)
    })

    it('ends the chain the moment a code wins', async () => {
        // A measured drop is the answer; there is nothing left to chain for.
        const el = document.createElement('div')
        el.id = 'total'
        Object.defineProperty(el, 'innerText', {
            value: 'Gesamt 60,00 €',
            configurable: true,
        })
        document.body.appendChild(el)
        await caramelBeginRun()
        await caramelMarkPendingSubmit('SALE20', 'c1', [80])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(await runRecord()).toBeNull()
        expect(finalModalCalls[0][0]).toBeCloseTo(20, 2)
    })
})
