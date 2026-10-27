import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// A form-POST cart can send its POST after the attempt stopped waiting
// (T-9245).
//
// Live on 4inkjets.com (Magento, 2026-10-27, shipped 1.4.20): INK18's POST left
// 9 s after the click, one second before the 10 s wait ran out. The runner
// judged INK18 on the old page, cleared the pending submit the next page reads,
// ended the run and drew its end card. The store's reload then wiped the card
// and loaded a page with nothing to resume: the shopper watched the run vanish.
//
// Once the page has started to leave, the code in flight and the rest of the
// run belong to the page it loads. The harness plays the browser: a
// `beforeunload` is the store's navigation starting; the background is the
// real handoff store, so what it holds is what the next page would read.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    applyCoupon: null,
    getCoupons: null,
    finalModalCalls: [],
}))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: (...args) => stubs.applyCoupon(...args),
    probeCartJson: async () => null, // non-Shopify: the DOM path
    _getTriedCodes: () => ({}),
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: (...args) => stubs.getCoupons(...args),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

let appliedCodes

/** The store's answer to every code: its old refusal, still on the page. */
function staleRefusal(code) {
    appliedCodes.push(code)
    return {
        success: false,
        newTotal: 84.95,
        committed: false,
        errorMsg: 'The coupon code "FALL18" is invalid or expired.',
        errorIsNew: false,
    }
}
const storeStartsNavigating = () =>
    window.dispatchEvent(new Event('beforeunload'))

/** Let the runner work through `ms` of its own timers. */
async function elapse(ms) {
    for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100)
}

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: (message, cb) => {
                if (handoffs.answers(message, cb)) return
                cb?.({})
            },
        },
        storage: {
            local: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            sync: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            session: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
        },
    }
    initCaramelBase()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handoffs.reset()
    sessionStorage.clear()
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    Object.defineProperty(document.getElementById('total'), 'innerText', {
        value: 'Subtotal $84.95',
        configurable: true,
    })
    window.history.replaceState({}, '', '/checkout/cart/')
    globalThis._caramelCancelled = false
    stubs.finalModalCalls = []
    appliedCodes = []
    stubs.getCoupons = async () =>
        ['FALL18', 'DEAL20', 'INK18'].map((code, i) => ({ code, id: `c${i}` }))
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('coupon-runner.js — a store POST that lands after the attempt stopped waiting', () => {
    it('holds the code in flight for the page the store loads', async () => {
        stubs.applyCoupon = async code => {
            if (code === 'FALL18') storeStartsNavigating()
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(5000)

        expect(appliedCodes).toEqual(['FALL18'])
        expect(await handoffs.peek('pending_submit')).toMatchObject({
            code: 'FALL18',
        })
        expect(await handoffs.peek('run')).not.toBeNull()
        expect(stubs.finalModalCalls).toEqual([])
    })

    it('hands the last code over when the navigation starts after its attempt returned', async () => {
        // 4inkjets' order of events: the wait ended, THEN the POST went out.
        stubs.applyCoupon = async code => {
            if (code === 'FALL18') setTimeout(storeStartsNavigating, 50)
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(5000)

        expect(appliedCodes).toEqual(['FALL18'])
        expect(await handoffs.peek('pending_submit')).toMatchObject({
            code: 'FALL18',
        })
        expect(await handoffs.peek('run')).not.toBeNull()
        expect(stubs.finalModalCalls).toEqual([])
    })

    it('keeps the run open when the navigation starts after the last code', async () => {
        stubs.getCoupons = async () => [{ code: 'FALL18', id: 'c0' }]
        stubs.applyCoupon = async code => {
            setTimeout(storeStartsNavigating, 50)
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(5000)

        expect(await handoffs.peek('run')).not.toBeNull()
        expect(await handoffs.peek('pending_submit')).toMatchObject({
            code: 'FALL18',
        })
        expect(stubs.finalModalCalls).toEqual([])
    })

    it('carries on with the next code when the page never actually leaves', async () => {
        // A navigation the page cancelled (a "leave site?" answered stay).
        stubs.applyCoupon = async code => {
            if (code === 'FALL18') storeStartsNavigating()
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(25000)

        expect(appliedCodes.slice(0, 2)).toEqual(['FALL18', 'DEAL20'])
    })

    it('does not mistake a same-document navigation for the page leaving', async () => {
        // A SPA cart moving its address bar stays on this document.
        const nav = new EventTarget()
        vi.stubGlobal('navigation', nav)
        stubs.applyCoupon = async code => {
            const e = new Event('navigate')
            e.destination = { sameDocument: true }
            nav.dispatchEvent(e)
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(3000)

        // Two stale refusals end the run on this page (the early exit), and
        // nothing was held for a next page: the run is over and closed.
        expect(appliedCodes).toEqual(['FALL18', 'DEAL20'])
        expect(await handoffs.peek('pending_submit')).toBeNull()
        expect(await handoffs.peek('run')).toBeNull()
        vi.unstubAllGlobals()
    })

    it('treats a cross-document navigate event as the page leaving', async () => {
        const nav = new EventTarget()
        vi.stubGlobal('navigation', nav)
        stubs.applyCoupon = async code => {
            const e = new Event('navigate')
            e.destination = { sameDocument: false }
            nav.dispatchEvent(e)
            return staleRefusal(code)
        }

        startApplyingCoupons(REC)
        await elapse(5000)

        expect(appliedCodes).toEqual(['FALL18'])
        expect(await handoffs.peek('pending_submit')).toMatchObject({
            code: 'FALL18',
        })
        vi.unstubAllGlobals()
    })
})
