import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// store.franklinplanner.com (BigCommerce), 1.4.32 and 1.4.33-rc, gated live
// 2026-11-02 and reproduced by hand 2026-11-03 (T-13010): a $19.50 cart, the
// run showed "Trying coupon 1 of 8 (CHEER)", then "Trying coupon 2 of 8
// (CHEER)", then "Auto-apply didn't stick". FPBDAY, in the same list, takes the
// GRAND TOTAL to $15.60 when typed by hand.
//
// Two causes, both pinned here:
// (1) The served list holds one code under two ids: CHEER, TREAT, SAVE10,
//     SHIP49 and CPT15 came back twice each, so the second try typed CHEER
//     again.
// (2) The checkout refuses a code with "Coupon does not apply" in an alert
//     beside the box, which the served errorIndicator does not match. The
//     generic reader only knew "doesn't apply", so each refusal read as no
//     answer, waited out the whole window, and after two such tries the run
//     stopped (EARLY_PROBE: "checkout not accepting injection").

let applyCoupon
let _caramelCleanCodes
let GENERIC_ERROR_TEXT_RE

// The config the app serves for this store (supported-stores, 2026-11-03).
const FRANKLIN_REC = {
    domain: 'store.franklinplanner.com',
    couponInput:
        'input[name="redeemableCode"], [data-test="redeemableEntry-input"]',
    couponSubmit: '[data-test="redeemableEntry-submit"]',
    priceContainer:
        '[data-test="cart-total"], .optimizedCheckout-orderSummary [data-test="cart-price-value"], .cart-priceItem--total .cart-priceItem-value',
    showInput: '[data-test="redeemable-label"], .redeemable-label',
    successIndicator:
        '[data-test="cart-coupon"], .cart-priceItem--coupon, [data-test="cart-priceItem-coupon"]',
    errorIndicator:
        '[data-test="redeemableEntry-input"] ~ .form-inlineMessage, [data-test="alert-error"], .redeemable-error, .form-field--error .form-inlineMessage',
    couponRemove:
        '[data-test="cart-coupon-remove-button"], .cart-priceItem--coupon [data-test*="remove"]',
}

// The checkout's order summary as it renders live (one-page checkout, the
// redeemable entry open). The refusal is drawn as a new alert inside the
// field, one level above the input's own wrapper. The line breaks between
// blocks stand in for the ones a browser's innerText puts there (jsdom's
// textContent would run "…does not applyGift Certificate…" together).
const PAGE =
    '<article class="cart optimizedCheckout-orderSummary" data-test="cart">' +
    '<section class="cart-section"><div id="redeemable-collapsable" data-test="redeemable-collapsable">' +
    '<fieldset class="form-fieldset redeemable-entry"><div class="form-field" id="field">' +
    '\n<label class="form-label is-srOnly">Gift Certificate or Coupon Code</label>\n' +
    '<div class="form-prefixPostfix">' +
    '<input class="form-input" name="redeemableCode" data-test="redeemableEntry-input">' +
    '<button id="applyRedeemableButton" data-test="redeemableEntry-submit">Apply</button>' +
    '</div>\n</div></fieldset></div></section>' +
    '<section class="cart-section"><div data-test="cart-total">GRAND TOTAL (USD) $19.50</div></section>' +
    '</article>'

const REFUSAL = 'Coupon does not apply'

/** The store answers a refused code a beat after the click, the way the live
 *  checkout does: the previous alert goes, a new one with the same sentence
 *  is drawn. */
function storeRefusesEveryCode() {
    document
        .querySelector('[data-test="redeemableEntry-submit"]')
        .addEventListener('click', () => {
            document.querySelector('.alertBox')?.remove()
            setTimeout(() => {
                const box = document.createElement('div')
                box.className = 'alertBox alertBox--error'
                box.innerHTML =
                    '<div class="alertBox-column alertBox-message" role="alert" aria-live="assertive"></div>'
                box.firstChild.textContent = REFUSAL
                document.getElementById('field').prepend(box, '\n')
            }, 150)
        })
}

beforeAll(() => {
    const { Element, HTMLElement } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
    // jsdom has no innerText; the generic reader walks containers by it.
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return this.textContent
        },
    })
})

beforeEach(async () => {
    document.body.innerHTML = PAGE
    vi.resetModules()
    ;({ applyCoupon, GENERIC_ERROR_TEXT_RE } =
        await import('../coupon-apply.js'))
    ;({ _caramelCleanCodes } = await import('../coupon-fetch.js'))
})

describe('franklinplanner: a code listed twice is tried once', () => {
    it('keeps the first of each code, whatever its case, in list order', () => {
        const served = [
            { id: '275848', code: 'CHEER' },
            { id: '275762', code: 'CHEER' },
            { id: '62061', code: '22132' },
            { id: '62055', code: 'SAVE10' },
            { id: '272973', code: 'FPBDAY' },
            { id: '153306', code: 'save10' },
            { id: '271664', code: 'TREAT ' },
            { id: '271028', code: 'TREAT' },
        ]

        const clean = _caramelCleanCodes(served)

        expect(clean.map(c => c.code)).toEqual([
            'CHEER',
            '22132',
            'SAVE10',
            'FPBDAY',
            'TREAT',
        ])
        expect(clean.map(c => c.id)).toEqual([
            '275848',
            '62061',
            '62055',
            '272973',
            '271664',
        ])
    })

    it('still drops a code left empty and passes a malformed entry through', () => {
        const clean = _caramelCleanCodes([
            { id: 'a', code: '​ ' },
            null,
            { id: 'b', code: 'FPBDAY' },
        ])
        expect(clean).toEqual([null, { id: 'b', code: 'FPBDAY' }])
    })
})

describe('franklinplanner: "Coupon does not apply" is the store answering', () => {
    it('the generic refusal words cover "does not apply" and both apostrophes', () => {
        for (const t of [
            'Coupon does not apply',
            "This code doesn't apply to your cart",
            'This code doesn’t apply to your cart',
            'doesnt apply',
        ])
            expect(GENERIC_ERROR_TEXT_RE.test(t), t).toBe(true)
        for (const t of ['Apply', 'Gift Certificate or Coupon Code'])
            expect(GENERIC_ERROR_TEXT_RE.test(t), t).toBe(false)
    })

    // TODO(T-13100): a configured box whose refusal is read here, beside the
    // box rather than by its errorIndicator, still waits the whole ~10s window
    // per code, and the same sentence redrawn for the next code is not
    // attributed to it (the early waiter and the redraw watch serve finder and
    // saved boxes only). Neither ends the run any more: the first refusal is
    // attributed (below), and the runner's signal is sticky.
    it('a refused code is the store answering this code, in its own words', async () => {
        storeRefusesEveryCode()

        const res = await applyCoupon('CHEER', FRANKLIN_REC)

        expect(res.success).toBe(false)
        // The store's own sentence, without the field's label or button.
        expect(res.errorMsg).toBe(REFUSAL)
        // What keeps the run going past EARLY_PROBE: an answer to THIS code.
        expect(res.errorIsNew).toBe(true)
    }, 20000)

    it('the next refused code still reads the store’s refusal', async () => {
        storeRefusesEveryCode()

        await applyCoupon('CHEER', FRANKLIN_REC)
        document.querySelector('input[name="redeemableCode"]').value = ''
        const second = await applyCoupon('22132', FRANKLIN_REC)

        expect(second.success).toBe(false)
        expect(second.errorMsg).toBe(REFUSAL)
    }, 30000)
})
