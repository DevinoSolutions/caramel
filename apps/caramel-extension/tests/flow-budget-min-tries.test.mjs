import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { startApplyingCoupons } from '../coupon-runner.js'

// The 35 s wall-clock budget must never be what stops a run before its first
// few codes were even tried (T-9105).
//
// Observed live on bumbleandbumble.com (2026-10-26, release check of 1.4.19 and
// of the 1.4.18 the stores served): two codes, NEWBBWELCOME15 (refused) then
// TEXT15 (15% off). On a busy machine the first refusal alone took longer than
// the budget, so the loop stopped before TEXT15 and the shopper got the copy
// list for a cart TEXT15 took $5.40 off on the very next run. The budget exists
// to stop a run churning eight failing codes at ~10 s each, not to skip the
// second of two.

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
// The runner reads wall time through performance.now(); each attempt below
// moves this clock by however long that attempt "took".
let clock

function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

/** A refusal the store wrote for this attempt, taking `ms` of wall time. */
function refusedAfter(ms) {
    return async code => {
        appliedCodes.push(code)
        clock += ms
        return {
            success: false,
            newTotal: 36,
            committed: false,
            errorMsg: `The offer code ${code.toLowerCase()} is not valid.`,
            errorIsNew: true,
        }
    }
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    window.history.replaceState({}, '', '/cart')
    setTotalText('Total $36.00')
    globalThis._caramelCancelled = false
    stubs.finalModalCalls = []
    appliedCodes = []
    clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('coupon-runner.js — the flow budget never cuts a run short of its first codes', () => {
    it('still tries the second code when the first refusal alone outran the budget', async () => {
        stubs.getCoupons = async () => [
            { code: 'NEWBBWELCOME15', id: 'c1' },
            { code: 'TEXT15', id: 'c2' },
        ]
        stubs.applyCoupon = refusedAfter(40000)

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['NEWBBWELCOME15', 'TEXT15'])
    })

    it('tries the first three codes however slow each one is', async () => {
        stubs.getCoupons = async () =>
            ['A1', 'B2', 'C3', 'D4', 'E5'].map((code, i) => ({
                code,
                id: `c${i}`,
            }))
        stubs.applyCoupon = refusedAfter(40000)

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['A1', 'B2', 'C3'])
    })

    it('still trims a long tail of failing codes once the budget is spent', async () => {
        stubs.getCoupons = async () =>
            ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'].map((code, i) => ({
                code,
                id: `c${i}`,
            }))
        // ~10 s per refusal, the churn the budget was written for: three codes
        // (30 s) are under it, the fourth starts at 30 s, and the fifth would
        // start past 35 s.
        stubs.applyCoupon = refusedAfter(10000)

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['A1', 'B2', 'C3', 'D4'])
    })
})
