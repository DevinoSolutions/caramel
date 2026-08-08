import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

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

let caramelBeginRun
let caramelClaimRunHop
let caramelEndRun
let caramelCancelRun
let caramelMarkPendingSubmit
let startCheckoutDetection

let applyCalls
let finalModalCalls

const REC = {
    domain: 'motoin.de',
    couponInput: '#promo',
    priceContainer: '#total',
}

const runRecord = () =>
    JSON.parse(sessionStorage.getItem('caramel_run') ?? 'null')

beforeAll(() => {
    ;({
        caramelBeginRun,
        caramelClaimRunHop,
        caramelEndRun,
        caramelCancelRun,
        caramelMarkPendingSubmit,
    } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        [
            'caramelBeginRun',
            'caramelClaimRunHop',
            'caramelEndRun',
            'caramelCancelRun',
            'caramelMarkPendingSubmit',
        ],
    ))
    startCheckoutDetection = globalThis.startCheckoutDetection
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = '<input id="promo" />'
    applyCalls = []
    finalModalCalls = []
    globalThis._isVisible = el => !!el
    globalThis.getDomainRecord = async () => REC
    globalThis.getCachedCodes = async () => [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    globalThis.insertCaramelPrompt = () => {}
    globalThis.isCheckout = async () => true
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    globalThis.caramelRecordSaving = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.startApplyingCoupons = async (...args) => applyCalls.push(args)
})

describe('the run record', () => {
    it('is opened once, so a second page cannot restart the clock', () => {
        caramelBeginRun()
        const first = runRecord()
        caramelBeginRun()

        expect(runRecord()).toEqual(first)
    })

    it('does not exist until somebody starts a run', () => {
        expect(caramelClaimRunHop()).toBeNull()
    })

    it('counts every hop it hands out', () => {
        caramelBeginRun()

        expect(caramelClaimRunHop().hops).toBe(1)
        expect(caramelClaimRunHop().hops).toBe(2)
    })

    it('stops handing out hops at the cap', () => {
        caramelBeginRun()
        const claimed = []
        for (let i = 0; i < 10; i++) claimed.push(caramelClaimRunHop())

        expect(claimed.filter(Boolean).length).toBe(6)
        expect(claimed[6]).toBeNull()
    })

    it('counts the hop even if the caller gives up afterwards', () => {
        // The increment is written inside the claim for exactly this reason —
        // a caller that returns early must not get a free retry.
        caramelBeginRun()
        caramelClaimRunHop()

        expect(runRecord().hops).toBe(1)
    })

    it('expires a chain that has been running too long', () => {
        sessionStorage.setItem(
            'caramel_run',
            JSON.stringify({ hops: 0, t: Date.now() - 181000 }),
        )

        expect(caramelClaimRunHop()).toBeNull()
        expect(runRecord()).toBeNull()
    })

    it('ends for good once cancelled', () => {
        caramelBeginRun()
        caramelCancelRun()

        expect(caramelClaimRunHop()).toBeNull()
    })

    it('lets the shopper start again after they cancelled', () => {
        // The cancelled record is a tombstone — hops pinned at the cap. Reading
        // it as "a run is already in flight" would mean one × silenced
        // continuation for the rest of the tab: press the pill again,
        // deliberately, and you are back to one code per reload with no way out
        // short of closing the tab. Pressing the pill IS the consent this runs
        // on, so it starts a fresh run.
        caramelBeginRun()
        caramelCancelRun()

        caramelBeginRun()

        expect(runRecord().hops).toBe(0)
        expect(caramelClaimRunHop().hops).toBe(1)
    })

    it('does not restart the clock on a run that is merely mid-flight', () => {
        // The guard above must not become "every page reopens the run", which
        // would make the hop cap meaningless.
        caramelBeginRun()
        caramelClaimRunHop()
        caramelClaimRunHop()

        caramelBeginRun()

        expect(runRecord().hops).toBe(2)
    })

    it('starts clean over an unreadable record rather than building on it', () => {
        sessionStorage.setItem('caramel_run', 'not json')

        caramelBeginRun()

        expect(runRecord().hops).toBe(0)
    })

    it('does not resurrect a run that was never open', () => {
        // Cancelling with nothing in flight must not write a record that a
        // later page would then have to reason about.
        caramelCancelRun()

        expect(runRecord()).toBeNull()
    })

    it('forgets a corrupted record instead of trusting it', () => {
        sessionStorage.setItem('caramel_run', 'not json')

        expect(caramelClaimRunHop()).toBeNull()
        expect(runRecord()).toBeNull()
    })

    it('is gone after it ends', () => {
        caramelBeginRun()
        caramelEndRun()

        expect(runRecord()).toBeNull()
        expect(caramelClaimRunHop()).toBeNull()
    })
})

describe('picking the loop back up after the store navigated', () => {
    it('carries on with the next code instead of asking for another click', async () => {
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toHaveLength(1)
        expect(applyCalls[0][1]).toEqual({ resumed: true })
    })

    it('says nothing terminal while it is still working', async () => {
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(finalModalCalls).toEqual([])
    })

    it('spends a hop each time it continues', async () => {
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(runRecord().hops).toBe(1)
    })

    it('reports the outcome instead when no run is open', async () => {
        // A single-shot apply the user never asked to chain.
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('will not continue on a page with no promo box', async () => {
        // The shopper navigated themselves. Submitting codes into a product
        // page would spend the chain on nothing.
        document.body.innerHTML = '<div>Product page</div>'
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('will not spend a reload on codes it has already tried', async () => {
        caramelBeginRun()
        globalThis._markTriedCode('SALE20')
        globalThis._markTriedCode('SPRING10')
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('stops when the shopper pressed × on the previous page', async () => {
        // The whole reason cancellation is written down: the × they clicked was
        // on a document the navigation then destroyed.
        caramelBeginRun()
        caramelCancelRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
    })

    it('stops once the hops are spent', async () => {
        sessionStorage.setItem(
            'caramel_run',
            JSON.stringify({ hops: 6, t: Date.now() }),
        )
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
    })

    it('still tells the shopper something if the resumed run throws', async () => {
        // Otherwise they are left behind an "Applying…" overlay with nothing
        // coming — the silence this whole handoff exists to end.
        let hidden = false
        globalThis.hideTestingModal = () => {
            hidden = true
        }
        globalThis.startApplyingCoupons = async () => {
            throw new Error('boom')
        }
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [])

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
        caramelBeginRun()
        caramelMarkPendingSubmit('SALE20', 'c1', [80])

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
        expect(runRecord()).toBeNull()
        expect(finalModalCalls[0][0]).toBeCloseTo(20, 2)
    })
})
