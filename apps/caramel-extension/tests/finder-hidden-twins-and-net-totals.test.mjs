import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelFindOrderTotal,
} from '../coupon-box-discovery.js'
import {
    installChromeStub,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// Two picks measured on real carts:
//   · a promo form a store draws twice with the SAME ids (a mobile copy hidden
//     on desktop, then the copy the shopper sees): the shown copy is the box
//     and its button, never the hidden twin;
//   · a summary that draws the net total ("Gesamtnettosumme", "Total excl.
//     VAT") beside the gross one: the gross total is the total.

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    setPath('/cart')
    _caramelResetDiscoveryFlag()
})

// 1800petmeds.com /cart (SFCC SFRA): the promo form, twice, same ids. Trimmed
// from the live page; the first copy is the mobile container (.d-none on
// desktop), the second the one the shopper sees.
const promoForm = (klass, style) =>
    `<div class="cart-promo-container ${klass}"${style ? ` style="${style}"` : ''}>` +
    '<div class="promo-code-text">Coupons</div>' +
    '<div class="enter-manually-text">or enter code manually</div>' +
    '<form action="/on/demandware.store/Sites-1800petmeds-Site/default/Cart-AddOfferCode" class="promo-code-form" method="GET">' +
    '<div class="btn-group" role="group">' +
    '<input type="text" class="form-control coupon-code-field" id="couponCode" name="couponCode" placeholder="">' +
    '<label for="couponCode">Enter promo code</label>' +
    '<button type="submit" id="promoCodeButton" class="btn btn-primary promo-code-btn">Apply</button>' +
    '</div></form></div>'
const TOTALS =
    '<div class="row"><span>Est. Total:</span><span>$4.27</span></div>' +
    '<div class="row"><span>Subtotal</span><span>$4.49</span></div>'
const TWINS =
    '<div class="cart-totals-container">' +
    TOTALS +
    promoForm('mobile', 'display:none') +
    promoForm('desktop') +
    '</div>'

describe('a promo form drawn twice with the same ids', () => {
    it('the shown copy is the box, not the hidden twin', () => {
        document.body.innerHTML = TWINS
        const [hiddenInput, shownInput] =
            document.querySelectorAll('#couponCode')
        const [, shownButton] = document.querySelectorAll('#promoCodeButton')

        const found = caramelDiscoverCouponBox()

        expect(found.input).toBe(shownInput)
        expect(found.input).not.toBe(hiddenInput)
        expect(found.inputVisible).toBe(true)
        expect(found.button).toBe(shownButton)
    })

    it("the shown copy's own label counts for it, not for the first id holder", () => {
        document.body.innerHTML = TWINS

        const found = caramelDiscoverCouponBox()

        expect(found.reasons.input).toContain('label:promo')
    })

    it('the hidden twin loses even when its surroundings score higher', () => {
        // Only the hidden copy sits in a form whose action names the coupon
        // (+25): on its own words it would outscore the shown copy.
        document.body.innerHTML = TWINS
        const [hiddenForm, shownForm] = document.querySelectorAll('form')
        hiddenForm.setAttribute('action', '/cart/coupon')
        shownForm.setAttribute('action', '/cart/apply')
        const [, shownInput] = document.querySelectorAll('#couponCode')

        const found = caramelDiscoverCouponBox()

        expect(found.input).toBe(shownInput)
        expect(found.inputVisible).toBe(true)
    })

    it('a page with one copy reads as before: its label counts wherever it sits', () => {
        document.body.innerHTML =
            '<label for="dc">Discount code</label>' +
            '<form><input id="dc" name="dc" type="text">' +
            '<button id="ap" type="button">Apply</button></form>' +
            TOTALS

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('dc')
        expect(found.reasons.input).toContain('label:discount')
    })

    it('a hidden box with no shown twin is still the box (for its toggle)', () => {
        document.body.innerHTML =
            '<div class="cart-totals-container">' +
            TOTALS +
            promoForm('mobile', 'display:none') +
            '</div>'

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('couponCode')
        expect(found.inputVisible).toBe(false)
        expect(found.reasons.input).toContain('label:promo')
    })
})

// fc-moto.com/de-de/checkout/cart (Shopware 6, German): the summary draws the
// net total and the VAT line under the gross total. Trimmed from the live dl.
const row = (label, value, klass = '') =>
    `<dt class="checkout-aside-summary-label ${klass}">${label}</dt>` +
    `<dd class="checkout-aside-summary-value ${klass}">${value}</dd>`
const GROSS = row('Gesamtsumme', '6,04&nbsp;€', 'checkout-aside-summary-total')
const NET =
    row('Gesamtnettosumme', '5,07&nbsp;€', 'summary-net') +
    row('zzgl. 19 % MwSt.', '0,97&nbsp;€', 'summary-tax')
const summary = rows =>
    '<dl class="checkout-aside-summary-list">' +
    row('Zwischensumme', '1,05&nbsp;€') +
    row('Versandkosten', '4,99&nbsp;€') +
    rows +
    '</dl>'

const totalText = () =>
    (caramelFindOrderTotal()?.textContent || '').replace(/\s+/g, ' ').trim()

describe('a summary that shows the net total beside the gross one', () => {
    it('the gross total is the total (German, net drawn under it)', () => {
        document.body.innerHTML = summary(GROSS + NET)

        expect(totalText()).toContain('6,04')
        expect(totalText()).not.toContain('5,07')
    })

    it('...and when the net rows are drawn above the gross one', () => {
        document.body.innerHTML = summary(NET + GROSS)

        expect(totalText()).toContain('6,04')
    })

    it.each([
        ['Total (excl. VAT)', 'Total', '£50.00', '£60.00'],
        ['Net total', 'Order total', '$50.00', '$60.00'],
        ['Total HT', 'Total TTC', '50,00 €', '60,00 €'],
        ['Totale imponibile', 'Totale', '50,00 €', '60,00 €'],
        ['Total excluding tax', 'Total', '$50.00', '$60.00'],
    ])('"%s" loses to "%s"', (net, gross, netAmount, grossAmount) => {
        document.body.innerHTML =
            '<div class="row"><span>' +
            gross +
            '</span><span>' +
            grossAmount +
            '</span></div>' +
            '<div class="row"><span>' +
            net +
            '</span><span>' +
            netAmount +
            '</span></div>'

        expect(totalText()).toContain(grossAmount)
    })

    it('a gross total that says it includes VAT is still the total', () => {
        document.body.innerHTML = summary(
            row('Gesamtsumme inkl. MwSt.', '6,04&nbsp;€') +
                row('Total (incl. VAT)', '6,04&nbsp;€'),
        )

        expect(totalText()).toContain('6,04')
    })

    it('a cart that shows only a net total shows no total', () => {
        document.body.innerHTML =
            '<div class="row"><span>Gesamtnettosumme</span><span>5,07 €</span></div>' +
            '<div class="row"><span>zzgl. 19 % MwSt.</span><span>0,97 €</span></div>'

        expect(caramelFindOrderTotal()).toBeNull()
    })
})
