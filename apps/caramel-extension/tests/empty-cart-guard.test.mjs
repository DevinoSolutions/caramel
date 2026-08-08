import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// A cart with nothing in it has nothing to discount, and running the apply loop
// against one is wrong in three directions at once.
//
// Observed on eddiebauer.com (2026-08-05): the prompt appeared over a cart
// reading "Your cart is empty / Total $0.00". Clicking it ran the full loop for
// ~23 SECONDS, submitted two live codes to the merchant against zero items, and
// then told the user to paste a code into an empty cart. The extension's own
// diagnosis was wrong too — it logged "no cart signal — checkout not accepting
// injection", blaming a store that was behaving perfectly. And the codes it
// burned went into the sticky tried-set, so a code described as "Take up to 15%
// Off" was skipped once a real $28 item was added.
//
// cricut.com and clarks.com already stay quiet on an empty cart, so some path
// knew better; this brings the rest of the fleet in line.

let startApplyingCoupons
let finalModalCalls
let appliedCodes

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    let el = document.getElementById('total')
    if (!el) {
        el = document.createElement('div')
        el.id = 'total'
        document.body.appendChild(el)
    }
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

beforeAll(() => {
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
        ['startApplyingCoupons'],
    )
    startApplyingCoupons = globalThis.startApplyingCoupons
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>'
    // A cart page unless a test says otherwise — the checkout-surface rule
    // below keys off the URL.
    window.history.replaceState({}, '', '/cart')
    globalThis._caramelCancelled = false
    finalModalCalls = []
    appliedCodes = []

    globalThis.getCoupons = async () => [
        { code: 'FIFTEENOFF', id: 'c1' },
        { code: 'TENOFF', id: 'c2' },
    ]
    globalThis._getTriedCodes = () => ({})
    globalThis._markTriedCode = () => {}
    globalThis._unmarkTriedCode = () => {}
    globalThis.probeCartJson = async () => null // non-Shopify: DOM path
    globalThis._isVisible = () => true // jsdom has no layout
    globalThis.waitUntilReady = async () => {}
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = () => {}
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    globalThis.applyCoupon = async code => {
        appliedCodes.push(code)
        return { success: false, newTotal: 0, committed: false, errorMsg: null }
    }
})

describe('coupon-runner.js — an empty cart is named, not ground through', () => {
    it('sends no code to the merchant when the order total reads zero', async () => {
        setTotalText('Merchandise Total (0 items) $0.00 Order Subtotal $0.00')

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual([])
    })

    it('tells the user their cart is empty instead of blaming the codes', async () => {
        setTotalText('Total $0.00')

        await startApplyingCoupons(REC)

        expect(finalModalCalls).toHaveLength(1)
        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/cart is empty/i)
        // The old copy told them to paste a code into a cart with no items.
        expect(message).not.toMatch(/didn't stick/i)
        expect(message).not.toMatch(/paste/i)
    })

    it('claims no saving on an empty cart', async () => {
        setTotalText('Total $0.00')

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][0]).toBe(0)
        expect(finalModalCalls[0][1]).toBeNull()
    })

    it('recognises an empty cart from the platform payload too', async () => {
        // Shopify-class stores answer probeCartJson, and there the item count
        // is authoritative even when no price element is configured.
        globalThis.probeCartJson = async () => ({
            item_count: 0,
            total_price: 0,
            currency: 'USD',
        })
        setTotalText('')

        await startApplyingCoupons({ ...REC, priceContainer: undefined })

        expect(appliedCodes).toEqual([])
        expect(finalModalCalls[0][2] ?? '').toMatch(/cart is empty/i)
    })

    it('does not believe the storefront payload once the shopper is IN the checkout', async () => {
        // The regression this guard caused, reproduced exactly (bombas.com,
        // 2026-08-06): Shopify moves the items into the checkout session, so
        // /cart.js on shop.<brand>.com answers "0 items" for a cart that is
        // plainly full — the store's own summary read "Total USD $70.50" one
        // inch from our modal. We told the shopper their cart was empty and
        // never attempted NATE, the one code our popup badges "✓ Verified",
        // worth $11.10 by hand on that same cart.
        // Driven by the checkout URL rather than the host, because jsdom won't
        // let a test move hosts; the live page matches both
        // (shop.bombas.com/checkouts/c/…) and either alone is enough.
        window.history.replaceState({}, '', '/checkouts/c/abc123')
        globalThis.probeCartJson = async () => ({
            item_count: 0,
            total_price: 0,
            currency: 'USD',
        })
        // The config's price selector doesn't match this checkout, so the DOM
        // says nothing either way — "unknown" must not read as "empty".
        setTotalText('')

        await startApplyingCoupons({ ...REC, priceContainer: undefined })

        expect(finalModalCalls[0]?.[2] ?? '').not.toMatch(/cart is empty/i)
        expect(appliedCodes).toEqual(['FIFTEENOFF', 'TENOFF'])
    })

    it('lets a readable total overrule a payload that says empty', async () => {
        // Same disagreement, the other way round: whatever the payload thinks,
        // a total the shopper can read is money in the cart.
        globalThis.probeCartJson = async () => ({
            item_count: 0,
            total_price: 0,
            currency: 'USD',
        })
        setTotalText('Total $70.50')

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0]?.[2] ?? '').not.toMatch(/cart is empty/i)
        expect(appliedCodes).toEqual(['FIFTEENOFF', 'TENOFF'])
    })

    it('still runs normally on a cart that HAS something in it', async () => {
        // Guards the guard: a $0.00 line somewhere must not silence a real
        // cart. returnLargest reads the ORDER TOTAL, so this is $28.00.
        setTotalText('Shipping $0.00 Order Total $28.00')

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['FIFTEENOFF', 'TENOFF'])
        expect(finalModalCalls[0][2] ?? '').not.toMatch(/cart is empty/i)
    })
})
