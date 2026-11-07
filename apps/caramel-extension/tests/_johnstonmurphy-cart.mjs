// johnstonmurphy.com's cart (SFCC, no Caramel config), captured live
// 2026-11-06 with one Ripley Plain Toe ($189.00) in the bag (T-14872). The
// markup is the store's own, trimmed of indentation and the long shipping-method
// tooltips; the line break between a row's label and amount cells is kept, as
// the store draws it. Rows the store hides with CSS (.hide-shipping-discount,
// .hide-order-discount, .d-none, the closed shipping dropdown) carry an inline
// display:none here, which is all the test layout stub reads.

export const JM_PROMO_FORM =
    '<form action="/on/demandware.store/Sites-johnston-murphy-us-Site/en_US/Cart-AddCoupon" class="promo-code-form" method="GET" name="promo-code-form">' +
    '<div class="form-group"><div class="row">' +
    '<div class="col-8"><input type="text" class="form-control coupon-code-field cartCouponInput" id="couponCode" name="couponCode" placeholder="Promo Code"></div>' +
    '<div class="col-4 pl-0"><button type="submit" class="btn btn-block btn-primary promo-code-btn addCoupon" value="dwfrm_cart_addCoupon" name="dwfrm_cart_addCoupon">APPLY</button></div>' +
    '<div class="col-12 coupon-error">' +
    '<span class="coupon-missing-error" id="missingCouponCode" role="alert" style="display: none;">No coupon code entered</span>' +
    '<span class="coupon-error-message" id="invalidCouponCode" role="alert"></span>' +
    '</div></div>' +
    '<input type="hidden" name="csrf_token" value="test-token"></div></form>' +
    '<div class="coupons-and-promos"></div>'

// The applied-code row J&M draws under the line items once FREESHIP26 takes.
export const JM_FREESHIP_ROW =
    '<div class="coupon-price-adjustment coupon-uuid-179a9a4b865601e7e0996dc655" data-uuid="179a9a4b865601e7e0996dc655">' +
    '<div class="coupon-code"><div class="promotion-callout">Promotion: <span><ul class="coupon-promotion-relationship">' +
    '<li>Enjoy Free Shipping On Us!</li></ul></span> (FREESHIP26)</div>' +
    '<button type="button" class="remove-coupon" data-code="FREESHIP26" aria-label="Remove coupon FREESHIP26">' +
    '<span aria-hidden="true">Remove</span></button></div></div>'

const shippingOption = (id, name, price, checked) =>
    '<span class="cart-shipping-option-row">' +
    `<input tabindex="0" class="RadioShippingMethods"${checked ? ' checked=""' : ''} type="radio" id="${id}" name="RadioShippingMethods" value="${id}">` +
    `<label for="${id}"><span class="shipping-details-top">` +
    `<span class="shipping-option-name" data-name="${name}">${name}:</span>` +
    `<span class="shipping-option-price "> ${price} </span>` +
    '<span class="shipping-tooltip">(Details)</span></span>' +
    '<span class="shipping-details-bottom"><span class="shipping-option-details">(Arrives in 4-7 Days)</span></span>' +
    '</label></span>'

// The order summary. `shippingDiscount` and `tax` are what the two rows the
// code changes read; `total` is the Estimated Total.
export function jmSummary({ shippingDiscount = null, tax = null, total }) {
    return (
        '<div class="order-summary"><h4 class="mb-3">Order Summary</h4>' +
        '<div class="d-flex justify-content-between mb-2"><span>Subtotal</span><span class="sub-total">$189.00</span></div>' +
        '<div class="mb-2 d-flex justify-content-between">' +
        '<div class="d-flex"><div class="">Shipping</div>' +
        '<div class="shipping-form-group pl-2">' +
        '<div id="expandCollapseCartShippingOptions" class="shipping-options-dropdown-toggle">' +
        '<span class="cart-shipping-select-title"><span class="display-name">GROUND</span><span class="small">▼</span></span></div>' +
        '<div class="cart-shipping-options shipping-options-dropdown" style="display:none">' +
        shippingOption('FedExGROUND', 'GROUND', '$9.95', true) +
        shippingOption('FedEx2ND', '2-Day', '$19.95', false) +
        shippingOption('FedExND', 'Next Day', '$27.95', false) +
        '</div></div></div>' +
        '<div class=""><div class="shipping-price-output"><div class="text-right shipping-cost">$9.95</div></div></div>' +
        '<div class="col-12 d-none" style="display:none"><div class="form-group"><label for="shippingMethods">Shipping</label>' +
        '<select class="custom-select form-control shippingMethods" id="shippingMethods" name="shippingMethods">' +
        '<option value="FedExGROUND" selected="">GROUND (Standard Ground orders will be delivered in 4-7 days.)</option>' +
        '<option value="FedEx2ND">2-Day (Orders placed after 12:00 PM CST will not be processed until the next business day.)</option>' +
        '<option value="FedExND">Next Day (Orders placed after 12:00 PM CST will not be processed until the next business day.)</option>' +
        '</select></div></div></div>' +
        `<div class="row shipping-discount mb-2${shippingDiscount ? '' : ' hide-shipping-discount" style="display:none'}">` +
        '<div class="col-8"><span class="text-danger">Shipping Discount</span></div>\n' +
        `<div class="col-4"><div class="text-right text-danger shipping-discount-total">- ${shippingDiscount || '$0.00'}</div></div></div>` +
        '<div class="row order-discount mb-2 hide-order-discount" style="display:none">' +
        '<div class="col-8"><span class="text-danger">Order Discount</span></div>\n' +
        '<div class="col-4"><div class="text-right order-discount-total text-danger"> - $0.00</div></div></div>' +
        '<div class="row mb-2"><div class="col-4"><span>Sales Tax</span></div>\n' +
        `<div class="col-8"><div class="text-right tax-total">${tax || 'calculated in checkout'}</div></div></div>` +
        '<div class="border-top">&nbsp;</div>' +
        '<div class="row  mb-3 pt-2"><div class="col-8"><strong>Estimated Total</strong></div>\n' +
        `<div class="col-4"><p class="text-right grand-total">${total}</p></div></div>` +
        '</div>'
    )
}

// Before any code, and after FREESHIP26, exactly as the store drew them.
export const JM_BEFORE = { total: '$198.95' }
export const JM_AFTER_FREESHIP = {
    shippingDiscount: '$9.95',
    tax: '$18.90',
    total: '$207.90',
}
