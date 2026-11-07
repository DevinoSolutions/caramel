import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
const handoffs = tabHandoffBackground()

// store.franklinplanner.com, 1.4.34 gate (2026-11-03, T-13318): a $19.50 cart.
// The form path tried the codes in the order served and stopped at its first
// win, SAVE10 (-$1.95). FPBDAY, later in the same list, takes -$3.90 by hand
// and was never tried. Each form try costs 8-10 s and the run ends at its first
// win, so the order IS the outcome: the form path now tries the codes the way
// the discount-link path already did (caramelRankByValue), best plausible
// value first inside each proof tier the app served.

const stubs = vi.hoisted(() => ({
    applyCoupon: null,
    getCoupons: null,
    tried: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        sleep: async () => {},
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: (...args) => stubs.applyCoupon(...args),
    probeCartJson: async () => null,
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
    showFinalModal: () => {},
}))

const REC = {
    domain: 'store.franklinplanner.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    errorIndicator: '.err',
}

const pct = (code, amount, status = 'valid') => ({
    id: code,
    code,
    status,
    discount_type: 'PERCENTAGE',
    discount_amount: amount,
})

function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            sendMessage: (msg, cb) => {
                if (handoffs.answers(msg, cb)) return
            },
        },
    }
    initCaramelBase()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(() => {
    handoffs.reset()
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Total $19.50')
    globalThis._caramelCancelled = false
    stubs.tried = []
    // Every code is refused, so the order the run tries them in is all we read.
    stubs.applyCoupon = async code => {
        stubs.tried.push(code)
        return {
            success: false,
            newTotal: NaN,
            committed: false,
            errorMsg: `${code} is not valid`,
            errorIsNew: true,
        }
    }
})

describe('the form path tries the biggest plausible saving first (T-13318)', () => {
    it('tries FPBDAY (20%) before SAVE10 (10%) when both are proven', async () => {
        stubs.getCoupons = async () => [pct('SAVE10', 10), pct('FPBDAY', 20)]

        await startApplyingCoupons(REC)

        expect(stubs.tried).toEqual(['FPBDAY', 'SAVE10'])
    })

    it('keeps a proven code ahead of a bigger unverified one: value never crosses a proof tier', async () => {
        stubs.getCoupons = async () => [
            pct('PROVEN5', 5),
            pct('UNVERIFIED50', 50, 'pending'),
        ]

        await startApplyingCoupons(REC)

        expect(stubs.tried).toEqual(['PROVEN5', 'UNVERIFIED50'])
    })

    it('picks the 8 it tries after ranking, so a big code served 9th is still tried', async () => {
        const served = [
            ...Array.from({ length: 8 }, (_, i) => pct(`SMALL${i + 1}`, 5)),
            pct('BIG30', 30),
        ]
        stubs.getCoupons = async () => served

        await startApplyingCoupons(REC)

        expect(stubs.tried[0]).toBe('BIG30')
        expect(stubs.tried).toHaveLength(8)
    })

    it('weighs a cash amount against the cart total: $5 off beats 10% of $19.50', async () => {
        stubs.getCoupons = async () => [
            pct('TENPCT', 10),
            {
                id: 'FIVE',
                code: 'FIVE',
                status: 'valid',
                discount_type: 'CASH',
                discount_amount: 5,
            },
        ]

        await startApplyingCoupons(REC)

        expect(stubs.tried).toEqual(['FIVE', 'TENPCT'])
    })
})
