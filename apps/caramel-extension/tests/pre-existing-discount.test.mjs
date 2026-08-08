import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// A cart that ALREADY has a discount on it is the most expensive thing this
// flow can get wrong, and the DOM path got it wrong twice over.
//
// 1. Cleanup between codes clicked the LAST visible remove button, reasoning
//    that the newest coupon renders last. On a cart where the shopper had
//    applied their own code, that is a coin flip — and losing it takes money
//    off their order through an action they never asked for.
// 2. The closing message read "Auto-apply didn't stick this time. Copy a code
//    and paste it in the store's promo box" — over a live discount. On most
//    checkouts a second code REPLACES the first, so following that advice is
//    what costs the money. The discount-link path already learned this against
//    real carts (goodr -$8.00, 1thrive -$20.00); this is the same honesty for
//    the path that drives the form.

let startApplyingCoupons
let removeAppliedCoupon
let finalModalCalls
let removedRows

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    successIndicator: '.applied-coupon',
    couponRemove: '.applied-coupon button',
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

/** Renders an applied-discount row with its own remove button. */
function addAppliedRow(code) {
    const row = document.createElement('div')
    row.className = 'applied-coupon'
    row.textContent = `${code} applied `
    const button = document.createElement('button')
    button.textContent = 'Remove'
    button.addEventListener('click', () => {
        removedRows.push(code)
        row.remove()
    })
    row.appendChild(button)
    document.body.appendChild(row)
    return row
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
    removeAppliedCoupon = globalThis.removeAppliedCoupon
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Order Total $80.00')
    removedRows = []
    finalModalCalls = []
    globalThis._caramelCancelled = false
    // The cleanup path waits ~600ms after each click for the cart to settle,
    // and the loop pauses between codes. Under a full-suite run that real time
    // is enough to trip the default per-test timeout, and none of it is what
    // these tests are about — which button gets clicked is.
    globalThis.sleep = async () => {}

    globalThis.getCoupons = async () => [
        { code: 'TRYME', id: 'c1' },
        { code: 'ORME', id: 'c2' },
    ]
    globalThis._getTriedCodes = () => ({})
    globalThis._markTriedCode = () => {}
    globalThis._unmarkTriedCode = () => {}
    globalThis.probeCartJson = async () => null // non-Shopify: DOM path
    globalThis._isVisible = el => !!el // jsdom has no layout
    globalThis.waitUntilReady = async () => {}
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = () => {}
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    // Every code "commits" a row and then errors — the exact state that
    // triggers cleanup.
    globalThis.applyCoupon = async code => {
        addAppliedRow(code)
        return {
            success: false,
            newTotal: 80,
            committed: true,
            errorMsg: 'Not valid for these items',
            // The store said it BECAUSE of this attempt — see
            // tests/store-said-attribution.test.mjs for what that gate means.
            errorIsNew: true,
        }
    }
})

describe('cleanup never removes a discount we did not add', () => {
    it("removes our own code's row, not the shopper's", async () => {
        addAppliedRow('SHOPPER50') // theirs, applied before we ran

        await startApplyingCoupons(REC)

        expect(removedRows).not.toContain('SHOPPER50')
        expect(removedRows).toEqual(['TRYME', 'ORME'])
    })

    it('leaves the cart alone when it cannot tell which row is ours', async () => {
        // Their discount is there; our code commits a row that does NOT name
        // the code (some checkouts render a generic "Discount" line). Removing
        // the only identifiable row would take theirs.
        addAppliedRow('SHOPPER50')
        globalThis.applyCoupon = async () => ({
            success: false,
            newTotal: 80,
            committed: true,
            errorMsg: 'Not valid for these items',
            // The store said it BECAUSE of this attempt — see
            // tests/store-said-attribution.test.mjs for what that gate means.
            errorIsNew: true,
        })

        await startApplyingCoupons(REC)

        expect(removedRows).toEqual([])
        expect(document.querySelectorAll('.applied-coupon')).toHaveLength(1)
    })

    it('still cleans up normally on a cart that arrived with no discount', async () => {
        // Guards the guard: the refusal must not stop ordinary cleanup, or
        // every failed code would stack up on the cart.
        await startApplyingCoupons(REC)

        expect(removedRows).toEqual(['TRYME', 'ORME'])
    })

    it('removes nothing at all when asked about a cart it did not change', async () => {
        addAppliedRow('SHOPPER50')

        const removed = await removeAppliedCoupon(REC, {
            code: 'OURCODE',
            hadPreExisting: true,
        })

        expect(removed).toBe(false)
        expect(removedRows).toEqual([])
    })
})

describe('an already-discounted cart is not reported as a failure', () => {
    it('names the live discount instead of blaming the codes', async () => {
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/already has a discount/i)
        expect(message).not.toMatch(/didn't stick/i)
    })

    it('warns that pasting another code may replace it', async () => {
        // The copy list is still offered — a shopper may genuinely want to
        // swap — but never without saying what a swap costs.
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2]).toMatch(/may replace/i)
        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it("still repeats the store's own words, and still warns", async () => {
        // The store's reason is the most useful thing we have and keeps
        // leading. What it must NOT keep is its usual "copy a code and paste
        // it" tail — that advice is precisely what costs the money here.
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/Not valid for these items/)
        expect(message).toMatch(/may replace/i)
        expect(message).not.toMatch(/paste it in the store's promo box/i)
    })

    it('says nothing about a pre-existing discount on a clean cart', async () => {
        globalThis.applyCoupon = async () => ({
            success: false,
            newTotal: 80,
            committed: false,
            errorMsg: null,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2] ?? '').not.toMatch(
            /already has a discount/i,
        )
    })
})
