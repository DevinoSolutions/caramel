import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// "The store said: …" has to be something the store actually said to US.
//
// mango.com/ae (QA sweep 2026-08-06): the modal read
// “The store said: رمز ترويجي”. That is not a rejection — it is the promo
// field's LABEL, "Promotional code", printed above the box the entire time. A
// shopper reading that is told, in the store's voice, that their code was
// refused for a reason they cannot parse. They stop trying.
//
// 38 of our configs carry the bare `[class*="error"]` pattern, so any element
// the selector happens to land on can end up quoted. The one test no static
// label can pass: the text has to be NEW — absent from the coupon area before
// we submitted.
//
// Deliberately narrow. Detection is untouched: `errorMsg` still decides the
// success rules and the no-signal early-exit exactly as before. Only what we
// BELIEVE about it is gated — the quote, the ✗ badge we put on the code, and
// the 'failed' verdict we teach the trust loop. A misfiring selector now costs
// us a quote instead of costing the shopper a working coupon.

let caramelQuoteIsAttributable
let _caramelCouponAreaText
let startApplyingCoupons
let finalModalCalls
let outcomeCalls

const REC = {
    domain: 'mango.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    errorIndicator: '[class*="error"]',
}

function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

beforeAll(() => {
    ;({ caramelQuoteIsAttributable, _caramelCouponAreaText } =
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
            ['caramelQuoteIsAttributable', '_caramelCouponAreaText'],
        ))
    startApplyingCoupons = globalThis.startApplyingCoupons
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Total $80.00')
    finalModalCalls = []
    outcomeCalls = []
    globalThis._caramelCancelled = false
    globalThis.sleep = async () => {}
    globalThis._getTriedCodes = () => ({})
    globalThis._markTriedCode = () => {}
    globalThis._unmarkTriedCode = () => {}
    globalThis.probeCartJson = async () => null
    globalThis._isVisible = el => !!el
    globalThis.waitUntilReady = async () => {}
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = (...args) => outcomeCalls.push(args)
    globalThis.caramelRecordSaving = () => {}
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    globalThis.getCoupons = async () => [{ code: 'PROMO10', id: 'c1' }]
})

describe('what counts as the store answering us', () => {
    it('refuses a label that was sitting there before we submitted', () => {
        // The mango case, in its own script.
        expect(
            caramelQuoteIsAttributable('رمز ترويجي', 'رمز ترويجي 80.00 ر.س'),
        ).toBe(false)
    })

    it('accepts text that appeared because of our attempt', () => {
        expect(
            caramelQuoteIsAttributable(
                'This code has expired',
                'Promotional code   Total $80.00',
            ),
        ).toBe(true)
    })

    it('is not fooled by casing or reflowed whitespace', () => {
        // innerText collapses differently once a container re-renders; that is
        // not the store changing its mind.
        expect(
            caramelQuoteIsAttributable(
                'Enter a  valid   code',
                'ENTER A VALID CODE',
            ),
        ).toBe(false)
    })

    it('has nothing to attribute when there is no text', () => {
        expect(caramelQuoteIsAttributable('', 'anything')).toBe(false)
        expect(caramelQuoteIsAttributable(null, 'anything')).toBe(false)
        expect(caramelQuoteIsAttributable('   ', 'anything')).toBe(false)
    })

    it('attributes anything when the area was blank before', () => {
        expect(caramelQuoteIsAttributable('Code not valid', '')).toBe(true)
        expect(caramelQuoteIsAttributable('Code not valid', null)).toBe(true)
    })
})

describe('the snapshot reads the same regions the detector does', () => {
    // The gate is only as good as what it remembers seeing. Both places
    // detectCouponError can pull a quote from have to be in the snapshot: the
    // errorIndicator matches, and the ancestor chain around the input that the
    // generic branch walks.
    beforeEach(() => {
        document.body.innerHTML =
            '<div id="box">' +
            '<label class="form-error-label" for="promo">رمز ترويجي</label>' +
            '<input id="promo" /><button id="apply">Apply</button>' +
            '<span class="promo-error"></span>' +
            '</div><div id="total"></div>'
    })

    it('remembers the label the config’s error selector lands on', () => {
        // `[class*="error"]` matches the LABEL here — the mango shape exactly.
        const prior = _caramelCouponAreaText(REC)

        expect(caramelQuoteIsAttributable('رمز ترويجي', prior)).toBe(false)
    })

    it('remembers text further up the box, where the generic branch looks', () => {
        // The generic branch returns a slice of an ancestor's innerText, so a
        // static hint several levels up must count as remembered.
        document
            .getElementById('box')
            .insertAdjacentHTML(
                'afterbegin',
                '<p>Gift cards are not valid with promotional codes</p>',
            )

        const prior = _caramelCouponAreaText(REC)

        expect(
            caramelQuoteIsAttributable(
                'Gift cards are not valid with promotional codes',
                prior,
            ),
        ).toBe(false)
    })

    it('still lets the store’s answer through', () => {
        const prior = _caramelCouponAreaText(REC)
        document.querySelector('.promo-error').textContent =
            'هذا الرمز غير صالح'

        expect(caramelQuoteIsAttributable('هذا الرمز غير صالح', prior)).toBe(
            true,
        )
    })

    it('does not throw on a config with no error selector or no input', () => {
        expect(() => _caramelCouponAreaText({ domain: 'x.com' })).not.toThrow()
        expect(() => _caramelCouponAreaText(null)).not.toThrow()
    })
})

describe('a quote we cannot attribute is not put in the store’s mouth', () => {
    beforeEach(() => {
        // The shape mango produced: nothing applies, and the only "error" text
        // is furniture that was always on the page.
        globalThis.applyCoupon = async () => ({
            success: false,
            newTotal: NaN,
            committed: false,
            errorMsg: 'رمز ترويجي',
            errorIsNew: false,
        })
    })

    it('says nothing rather than quoting the page’s furniture', async () => {
        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2]
        expect(message ?? '').not.toMatch(/store said/i)
    })

    it('does not brand the code rejected on that evidence', async () => {
        await startApplyingCoupons(REC)

        const offered = finalModalCalls[0][4] ?? []
        expect(offered.map(c => c.rejected)).not.toContain(true)
    })

    it('teaches the trust loop nothing it cannot support', async () => {
        // The same class of mistake as filing an infra failure as a verdict:
        // a code marked 'failed' here is buried for every future shopper.
        await startApplyingCoupons(REC)

        expect(outcomeCalls).toEqual([])
    })

    it('still offers the code to copy', async () => {
        // Golden rule: the store has coupons, so the shopper stays served.
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][4]?.length).toBe(1)
    })
})

describe('a real rejection is still repeated, word for word', () => {
    beforeEach(() => {
        globalThis.applyCoupon = async () => ({
            success: false,
            newTotal: NaN,
            committed: false,
            errorMsg: 'PROMO10 has expired',
            errorIsNew: true,
        })
    })

    it('quotes the store', async () => {
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2]).toMatch(/store said/i)
        expect(finalModalCalls[0][2]).toMatch(/PROMO10 has expired/)
    })

    it('marks the code and reports the failure with the reason', async () => {
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][4][0].rejected).toBe(true)
        expect(outcomeCalls).toEqual([['c1', 'failed', 'PROMO10 has expired']])
    })
})

describe('our own exception text is never a store quote', () => {
    it('stays silent when the attempt threw', async () => {
        // applyCoupon's catch returns String(err) as errorMsg. Showing a
        // shopper “The store said: TypeError: … is not a function” is our bug
        // wearing the merchant's name.
        globalThis.applyCoupon = async () => ({
            success: false,
            committed: false,
            errorMsg: 'TypeError: qOne(...) is not a function',
            errorIsNew: false,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2] ?? '').not.toMatch(/TypeError/)
        expect(outcomeCalls).toEqual([])
    })
})
