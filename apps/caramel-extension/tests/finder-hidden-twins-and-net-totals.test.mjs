import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelFindOrderTotal,
    caramelFinderSeesBox,
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
//     VAT") beside the gross one: the gross total is the total;
//   · a bag that works out sales tax only at checkout and so draws no total
//     but "Total excluding tax" (ikea.com/us): that row is its subtotal.

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

// ikea.com/us/en/shoppingcart (2026-10-31, one item in the bag): the summary
// is "Products" and "Total excluding tax", tax is added at checkout, and the
// promo box is folded under an "Apply discount code" accordion. Trimmed from
// the live page; the closed region is drawn display:none, as the harness
// reads a fold. Before T-11710 the finder read no total here, so the prompt
// never showed on a bag with codes for it.
// The screen-reader copy's computed style, as measured on the live page.
const SR_ONLY =
    'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px)'
const price = (amount, sr) =>
    '<span class="cart-ingka-price"><span aria-hidden="true" class="notranslate">' +
    '<span class="cart-ingka-price__nowrap"><span class="cart-ingka-price__currency">$</span>' +
    `<span class="cart-ingka-price__integer">${amount.split('.')[0]}</span></span>` +
    '<span class="cart-ingka-price__decimal"><span class="cart-ingka-price__separator">.</span>' +
    `${amount.split('.')[1]}</span></span>` +
    `<span class="cart-ingka-price__sr-text" style="${SR_ONLY}">${sr}</span></span>`
const ikeaSummary = (totalLabel = 'Total excluding tax') =>
    '<h2>Order summary</h2><table><tbody>' +
    `<tr><th scope="row"><span>Products</span></th><td>${price('79.99', '$ 79.99')}</td></tr>` +
    '<tr><td colspan="2"><span>Shipping costs are calculated at checkout</span></td></tr>' +
    '</tbody><tfoot><tr id="order-summary-total" aria-live="polite">' +
    `<th scope="row"><span>${totalLabel}</span></th>` +
    `<td>${price('79.99', `${totalLabel} $ 79.99`)}</td></tr></tfoot></table>`
const IKEA_FOLD =
    '<ul class="cart-ingka-accordion"><li id="cart-coupon"><div role="heading" aria-level="2">' +
    '<button type="button" id="fold" class="cart-ingka-accordion__heading" aria-controls="SEC_cart-coupon" aria-expanded="false">' +
    '<span><span id="SEC_cart-coupon_title"><div class="cart-ingka-ssr-label">Apply discount code</div></span></span>' +
    '</button></div>' +
    '<div id="SEC_cart-coupon" role="region" style="display:none" aria-labelledby="SEC_cart-coupon_title">' +
    '<form novalidate=""><input id="discountcode-input" aria-label="Discount code" type="text" value="">' +
    '<button type="submit"><span>Apply</span></button></form></div></li></ul>'

describe('a bag that shows only a total before sales tax', () => {
    beforeEach(() => setPath('/us/en/shoppingcart/'))

    it('reads "Total excluding tax" as the total of the bag (ikea.com)', () => {
        document.body.innerHTML = ikeaSummary() + IKEA_FOLD

        expect(totalText()).toContain('Total excluding tax')
        expect(totalText()).toContain('79')
    })

    it('so the finder sees the folded promo box and the prompt can show', () => {
        document.body.innerHTML = ikeaSummary() + IKEA_FOLD

        expect(caramelDiscoverCouponBox().toggle?.id).toBe('fold')
        expect(caramelFinderSeesBox()).toBe(true)
    })

    it.each([
        'Total excluding tax',
        'Total excl. tax',
        'Total before tax',
        'Total (excluding tax)',
        'Estimated total before tax',
        'Order total excluding sales tax',
    ])('"%s" is read when the bag shows nothing else', label => {
        document.body.innerHTML = ikeaSummary(label)

        expect(totalText()).toContain(label)
    })

    it('a subtotal on the same bag is still read first', () => {
        document.body.innerHTML =
            '<div class="row"><span>Subtotal</span><span>$70.00</span></div>' +
            '<div class="row"><span>Total excluding tax</span><span>$79.99</span></div>'

        expect(totalText()).toContain('70.00')
    })

    it('a gross total on the same bag is still the total', () => {
        document.body.innerHTML =
            '<div class="row"><span>Total excluding tax</span><span>$79.99</span></div>' +
            '<div class="row"><span>Total</span><span>$86.39</span></div>'

        expect(totalText()).toContain('86.39')
    })

    it.each([
        'Total excluding shipping',
        'Total excluding tax and shipping',
        'Total savings before tax',
        'Total (excl. VAT)',
        'Total HT',
    ])('"%s" alone is still no total', label => {
        document.body.innerHTML = `<div class="row"><span>${label}</span><span>$79.99</span></div>`

        expect(caramelFindOrderTotal()).toBeNull()
    })

    it('a row whose cell repeats it for a screen reader is one amount', () => {
        document.body.innerHTML =
            '<div class="row"><span>Total</span><span>$79.99' +
            `<span style="${SR_ONLY}">Total $ 79.99</span></span></div>`

        expect(caramelFindOrderTotal()).not.toBeNull()
    })

    it('...but the same copy drawn for the eye is a second amount', () => {
        document.body.innerHTML =
            '<div class="row"><span>Total</span><span>$79.99' +
            '<span>Total $ 79.99</span></span></div>'

        expect(caramelFindOrderTotal()).toBeNull()
    })
})
