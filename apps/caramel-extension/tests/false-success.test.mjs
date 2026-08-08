import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

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

let caramelAcceptedRowCount
let caramelRowReadsRejected
let startApplyingCoupons
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

beforeAll(() => {
    ;({ caramelAcceptedRowCount, caramelRowReadsRejected } =
        loadExtensionSources(
            [
                'coupon-constants.generated.js',
                'caramel-base.js',
                'dom-utils.js',
                'store-detect.js',
                'coupon-apply.js',
                'coupon-fetch.js',
                'coupon-runner.js',
            ],
            ['caramelAcceptedRowCount', 'caramelRowReadsRejected'],
        ))
    startApplyingCoupons = globalThis.startApplyingCoupons
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Estimated Total $33.23')
    finalModalCalls = []
    globalThis._caramelCancelled = false
    globalThis.sleep = async () => {}
    globalThis.getCoupons = async () => [{ code: 'WELCOME25', id: 'c1' }]
    globalThis._getTriedCodes = () => ({})
    globalThis._markTriedCode = () => {}
    globalThis._unmarkTriedCode = () => {}
    globalThis.probeCartJson = async () => null
    globalThis._isVisible = el => !!el
    globalThis.waitUntilReady = async () => {}
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = () => {}
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
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
        globalThis.applyCoupon = async () => ({
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
        globalThis.applyCoupon = async () => {
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
