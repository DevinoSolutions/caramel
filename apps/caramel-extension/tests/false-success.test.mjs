import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    caramelAcceptedRowCount,
    caramelRowReadsRejected,
} from '../coupon-apply.js'
import { startApplyingCoupons } from '../coupon-runner.js'

// The worst thing this product can say is "✓ Coupon Applied" when nothing was.
//
// allposters.com (QA sweep 2026-08-05), measured against the store's own
// summary: total $33.23 before, $33.23 after, $33.23 after a reload, promo box
// empty, and the store printing "25% Off Everything* — Not Applied ✕" twice in
// red beside our modal. We showed "✓ Coupon Applied / Discount visible in your
// cart" with a Proceed to Checkout button under it.
//
// Two separate mistakes produced that, and both are fixed here:
//
// 1. The rejection notices THEMSELVES were counted as success. Success means
//    "a new row appeared where applied coupons live" — and the store rendered
//    its "Not Applied" notices inside exactly that container. We read the rows
//    now, and a row that says it was not applied is not evidence that it was.
//
// 2. A code that moved no READABLE total was still headlined as applied, with
//    a minimum spend offered as the explanation. The real reason was printed
//    on the page: the store does not combine promo codes with the sitewide
//    promo already on the cart.

// The old harness let a test replace a collaborator by assigning over the
// global the source file read (`globalThis.applyCoupon = …`). ES modules bind
// their imports, so the same seam is a module mock whose factory forwards to a
// per-test slot — assigning `stubs.applyCoupon` in a beforeEach reads exactly
// as the global assignment did.
const stubs = vi.hoisted(() => ({
    applyCoupon: null,
    getCoupons: null,
    probeCartJson: null,
    finalModalCalls: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is assigned by initCaramelBase(); a spread would
        // freeze it at undefined, so the live binding is passed through.
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
    probeCartJson: (...args) => stubs.probeCartJson(...args),
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

let finalModalCalls

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    successIndicator: '.promo-row',
}

function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

function addRow(text) {
    const row = document.createElement('div')
    row.className = 'promo-row'
    row.textContent = text
    document.body.appendChild(row)
    return row
}

/** jsdom implements no layout, so nothing reports itself visible. */
function alwaysVisible() {
    return true
}

// jsdom performs no layout, so dom-utils' _isVisible fails closed on every
// element. The old `globalThis._isVisible = el => !!el` said "everything on
// this page is visible"; implementing the one signal the real function reads
// says the same thing, and keeps dom-utils unmocked (coupon-runner reads its
// live `_caramelLastPrices` binding, which a mock factory's spread freezes).
beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = alwaysVisible
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Estimated Total $33.23')
    finalModalCalls = stubs.finalModalCalls = []
    globalThis._caramelCancelled = false
    stubs.getCoupons = async () => [{ code: 'WELCOME25', id: 'c1' }]
    stubs.probeCartJson = async () => null
})

describe("a row that says 'Not Applied' is not a success", () => {
    it('does not count the rejection notice the store just rendered', () => {
        addRow('25% Off Everything*  Not Applied ✕')

        expect(caramelAcceptedRowCount('.promo-row')).toBe(0)
    })

    it('still counts a genuine applied row', () => {
        // Guards the guard: this only ever removes a signal, never invents one.
        addRow('SAVE10 applied  −$10.00')

        expect(caramelAcceptedRowCount('.promo-row')).toBe(1)
    })

    it('counts a row that says nothing either way', () => {
        addRow('')
        addRow('Discount')

        expect(caramelAcceptedRowCount('.promo-row')).toBe(2)
    })

    it('reads the store, not just the selector', () => {
        expect(caramelRowReadsRejected(addRow('Not Applied'))).toBe(true)
        expect(caramelRowReadsRejected(addRow('Coupon has expired'))).toBe(true)
        expect(caramelRowReadsRejected(addRow('Code is invalid'))).toBe(true)
        expect(caramelRowReadsRejected(addRow('WELCOME25 −$8.75'))).toBe(false)
    })
})

describe('an unchanged total is never headlined as applied', () => {
    beforeEach(() => {
        // The allposters shape: the code "commits" (a row appears), no error
        // text is detectable, and the total does not move.
        stubs.applyCoupon = async () => ({
            success: true,
            newTotal: 33.23,
            committed: true,
            errorMsg: null,
        })
    })

    it('claims no saving and does not call the code applied', async () => {
        await startApplyingCoupons(REC)

        const [amount, appliedCode] = finalModalCalls[0]
        expect(amount).toBe(0)
        // appliedCode is what renders the "✓ Coupon Applied" heading and the
        // "Discount visible in your cart" line.
        expect(appliedCode).toBeNull()
    })

    it('says what it did and what it saw, without the minimum-spend verdict', async () => {
        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/WELCOME25/)
        expect(message).toMatch(/total didn't change/i)
        expect(message).toMatch(/check your order summary/i)
        // The old copy asserted a reason it had not established.
        expect(message).not.toMatch(/hasn't changed the total yet/i)
    })

    it('offers the other codes instead of a dead end', async () => {
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it('still reports a real, measured win as a win', async () => {
        // Guards the guard: the honest path must not swallow genuine savings.
        stubs.applyCoupon = async () => {
            setTotalText('Estimated Total $25.23')
            return {
                success: true,
                newTotal: 25.23,
                committed: true,
                errorMsg: null,
            }
        }

        await startApplyingCoupons(REC)

        const [amount, appliedCode] = finalModalCalls[0]
        expect(amount).toBeCloseTo(8, 2)
        expect(appliedCode).toBe('WELCOME25')
    })
})
