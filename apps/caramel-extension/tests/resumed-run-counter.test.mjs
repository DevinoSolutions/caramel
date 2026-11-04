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

// The overlay's "Trying coupon N of M" on the page a reload resumes a run on.
//
// Live on 4inkjets.com (1.4.21, 2026-10-27): FALL18 was tried, the store
// reloaded the cart, and the resumed page said "Trying coupon 1 of 8 (DEAL20)"
// — the count started over on every reload, so a shopper watching a long run
// saw it go back to 1 each time.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({ tried: {}, counter: [] }))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async () => ({
        success: false,
        newTotal: 84.95,
        committed: true,
        errorMsg: '',
        errorIsNew: false,
    }),
    probeCartJson: async () => null, // non-Shopify: the DOM path
    _getTriedCodes: () => stubs.tried,
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        ['FALL18', 'DEAL20', 'INK18'].map((code, i) => ({ code, id: `c${i}` })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async (n, total, code) =>
        stubs.counter.push(`${n}/${total} ${code}`),
    hideTestingModal: () => {},
    showFinalModal: () => {},
}))

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

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
    globalThis._caramelCancelled = false
    stubs.counter = []
    stubs.tried = {}
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — the counter on a resumed run', () => {
    it('carries on from the codes tried on the pages before', async () => {
        stubs.tried = { FALL18: Date.now() }

        startApplyingCoupons(REC, { resumed: true })
        await elapse(60000)

        expect(stubs.counter).toEqual(['2/3 DEAL20', '3/3 INK18'])
    })

    it('counts from 1 on a run the shopper just started', async () => {
        // A fresh press skips recently tried codes too, but counts its own.
        stubs.tried = { FALL18: Date.now() }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.counter).toEqual(['1/2 DEAL20', '2/2 INK18'])
    })
})
