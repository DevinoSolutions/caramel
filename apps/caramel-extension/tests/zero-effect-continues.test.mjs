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

// A code the store ACCEPTS that takes nothing off the total (T-9443).
//
// Live on cbd.co (WooCommerce, 1.4.21, 2026-10-27): the store applied 15MORE
// as "Coupon: 15more -US$0.00" with its success message, the run stopped at
// that first "success", and the seven other codes were never tried. While
// codes remain, such a code comes back off and the run carries on; a total
// that is only slow to re-render must not cost a code that worked.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    answers: {},
    applied: [],
    removed: [],
    finalModalCalls: [],
}))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async code => {
        stubs.applied.push(code)
        return stubs.answers[code]()
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
        ['15MORE', 'FAVS20', 'HONOR25'].map((code, i) => ({
            code,
            id: `c${i}`,
        })),
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

/** What the store's total box reads now. */
function totalReads(text) {
    Object.defineProperty(document.getElementById('total'), 'innerText', {
        value: text,
        configurable: true,
    })
    document.getElementById('total').textContent = text
}
const accepted = newTotal => () => ({
    success: true,
    newTotal,
    committed: true,
    errorMsg: '',
    errorIsNew: false,
})
const refused = () => ({
    success: false,
    newTotal: 36.69,
    committed: false,
    errorMsg: 'Coupon is not valid.',
    errorIsNew: true,
})

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
    totalReads('Total $36.69')
    globalThis._caramelCancelled = false
    stubs.applied = []
    stubs.removed = []
    stubs.finalModalCalls = []
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — a code the store accepts at $0 off', () => {
    it('takes it back off and goes on to a code that saves', async () => {
        stubs.answers = {
            '15MORE': accepted(36.69),
            FAVS20: () => {
                totalReads('Total $29.35')
                return accepted(29.35)()
            },
            HONOR25: refused,
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['15MORE', 'FAVS20'])
        expect(stubs.removed).toEqual(['15MORE'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('FAVS20')
        expect(saved).toBeCloseTo(7.34, 2)
    })

    it('keeps a code whose total only re-renders late', async () => {
        stubs.answers = {
            '15MORE': () => {
                // The total drops 800 ms after the attempt returned.
                setTimeout(() => totalReads('Total $31.19'), 800)
                return accepted(36.69)()
            },
            FAVS20: refused,
            HONOR25: refused,
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['15MORE'])
        expect(stubs.removed).toEqual([])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('15MORE')
        expect(saved).toBeCloseTo(5.5, 2)
    })

    it('tries every code, and leaves the last one on when none saves', async () => {
        stubs.answers = {
            '15MORE': accepted(36.69),
            FAVS20: accepted(36.69),
            HONOR25: accepted(36.69),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['15MORE', 'FAVS20', 'HONOR25'])
        expect(stubs.removed).toEqual(['15MORE', 'FAVS20'])
        const [, , message] = stubs.finalModalCalls.at(-1)
        expect(message).toMatch(/We put HONOR25 into the promo box/)
    })
})
