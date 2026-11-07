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

// A code the store refuses by listing it "NOT APPLIED" stays on the cart.
//
// Live on aquasana.com (Salesforce Commerce Cloud, 2026-10-27): JULY50 and
// EMAILPRE50 were each left as a "NOT APPLIED" row, and the third code,
// FAMILY50, was refused with "Coupon cannot be combined with other coupons
// already in your cart." Every code after a refused one was judged against a
// cart we had cluttered. The refused row comes off before the next code
// (T-9569).

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    applied: [],
    removed: [],
}))

const rowRefusal = code => ({
    success: false,
    newTotal: 80.48,
    committed: false,
    errorMsg: `${code} NOT APPLIED ×`,
    errorIsNew: true,
    answeredByRow: true,
})
const textRefusal = () => ({
    success: false,
    newTotal: 80.48,
    committed: false,
    errorMsg: 'Code not found',
    errorIsNew: true,
    answeredByRow: false,
})

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async code => {
        stubs.applied.push(code)
        return code === 'GONE' ? textRefusal() : rowRefusal(code)
    },
    removeAppliedCoupon: async (_rec, { code }) => {
        stubs.removed.push(code)
    },
    probeCartJson: async () => null, // non-Shopify: the DOM path
    _getTriedCodes: () => ({}),
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        ['JULY50', 'GONE', 'EMAILPRE50'].map((code, i) => ({
            code,
            id: `c${i}`,
        })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
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
        value: 'Total $80.48',
        configurable: true,
    })
    globalThis._caramelCancelled = false
    stubs.applied = []
    stubs.removed = []
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — a code refused as a "NOT APPLIED" row', () => {
    it('takes each such row off, tries every code, and leaves text refusals alone', async () => {
        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['JULY50', 'GONE', 'EMAILPRE50'])
        expect(stubs.removed).toEqual(['JULY50', 'EMAILPRE50'])
    })
})
