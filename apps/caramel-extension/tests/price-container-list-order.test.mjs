import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

/**
 * A config's priceContainer is a selector LIST written in priority order: the
 * store's own total first, broader fallbacks after it (T-12490). 1204 of the
 * 2683 served configs with a priceContainer are such lists (2026-11-02).
 *
 * querySelector(list) does not honour that order: it returns whichever match
 * comes first in the page. store.franklinplanner.com's served config is
 *
 *   [data-test="cart-total"], .optimizedCheckout-orderSummary
 *   [data-test="cart-price-value"], .cart-priceItem--total .cart-priceItem-value
 *
 * and BigCommerce's checkout draws the Subtotal row (its own
 * [data-test="cart-price-value"]) above [data-test="cart-total"]. Every read
 * was the Subtotal, $17.95, while FPBDAY took the grand total to $14.36 within
 * 5 s of Apply (probe 2026-11-02); the run said "Auto-apply didn't stick" over
 * a code that was saving the shopper money. cbd.co (WooCommerce) read its
 * pre-discount `.cart-subtotal .amount` the same way.
 *
 * The fixture below is the real checkout's order summary, trimmed to the
 * parts the selectors touch, with the REAL served selector list.
 */

const FRANKLIN_PRICE =
    '[data-test="cart-total"], .optimizedCheckout-orderSummary [data-test="cart-price-value"], .cart-priceItem--total .cart-priceItem-value'

const FRANKLIN_REC = {
    domain: 'store.franklinplanner.com',
    couponInput:
        'input[name="redeemableCode"], [data-test="redeemableEntry-input"]',
    couponSubmit: '[data-test="redeemableEntry-submit"]',
    priceContainer: FRANKLIN_PRICE,
    successIndicator:
        '[data-test="cart-coupon"], .cart-priceItem--coupon, [data-test="cart-priceItem-coupon"]',
    errorIndicator:
        '[data-test="redeemableEntry-input"] ~ .form-inlineMessage, [data-test="alert-error"], .redeemable-error, .form-field--error .form-inlineMessage',
    couponRemove: null,
}

const priceRow = (test, label, value) =>
    `<div data-test="${test}"><div class="cart-priceItem"><span class="cart-priceItem-label">` +
    `<span data-test="cart-price-label">${label}</span></span>` +
    `<span class="cart-priceItem-value"><span data-test="cart-price-value">${value}</span></span></div></div>`

const FRANKLIN_CHECKOUT =
    '<aside><article class="cart optimizedCheckout-orderSummary" data-test="cart">' +
    '<section class="cart-section">' +
    priceRow('cart-subtotal', 'Subtotal(USD)', '$17.95') +
    '<div id="coupons"></div>' +
    priceRow('cart-shipping', 'Shipping', '--') +
    priceRow('cart-taxes', 'Tax', '$0.00') +
    '<input name="redeemableCode" data-test="redeemableEntry-input" />' +
    '<button data-test="redeemableEntry-submit" type="button">Apply</button>' +
    '</section><section class="cart-section">' +
    '<div data-test="cart-total"><div class="cart-priceItem cart-priceItem--total">' +
    '<span class="cart-priceItem-label"><span data-test="cart-price-label">Grand Total (USD)</span></span>' +
    '<span class="cart-priceItem-value"><span data-test="cart-price-value" id="grand">$17.95</span></span>' +
    '</div></div></section></article></aside>'

/** FPBDAY as the real checkout drew it: a coupon row, the grand total down. */
function franklinTakesFpbday() {
    document.getElementById('coupons').innerHTML =
        '<div data-test="cart-coupon"><div class="cart-priceItem">' +
        '<span class="cart-priceItem-label"><span data-test="cart-price-label">Save 20% off your entire order</span>' +
        '<span class="cart-priceItem-link"><a data-test="cart-price-callback" href="#">Remove</a></span></span>' +
        '<span class="cart-priceItem-value"><span class="sub-icon">-</span><span data-test="cart-price-value">$3.59</span></span>' +
        '<span class="cart-priceItem-postFix" data-test="cart-price-code">FPBDAY</span></div></div>'
    document.getElementById('grand').textContent = '$14.36'
}

// jsdom computes no layout: innerText is undefined (getPrice reads it) and
// nothing reports itself visible. Both get the one answer they need.
const innerText = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'innerText',
)
beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        get() {
            return this.textContent
        },
        configurable: true,
    })
    Element.prototype.checkVisibility = () => true
})
afterAll(() => {
    if (innerText)
        Object.defineProperty(HTMLElement.prototype, 'innerText', innerText)
    else delete HTMLElement.prototype.innerText
    delete Element.prototype.checkVisibility
})

let dom
beforeEach(async () => {
    document.body.innerHTML = FRANKLIN_CHECKOUT
    // getPrice keeps module state (_caramelLastPrices): a fresh registry per test.
    vi.resetModules()
    dom = await import('../dom-utils.js')
})

describe('a config selector list is read in list order, not page order', () => {
    it('reads the grand total on the BigCommerce checkout, not the Subtotal drawn above it', () => {
        franklinTakesFpbday()
        expect(dom.getPrice(FRANKLIN_PRICE, { returnLargest: true })).toBe(
            14.36,
        )
    })

    it('measures FPBDAY taking $17.95 to $14.36 through the real applyCoupon', async () => {
        const { applyCoupon } = await import('../coupon-apply.js')
        document
            .querySelector('[data-test="redeemableEntry-submit"]')
            .addEventListener('click', () =>
                setTimeout(franklinTakesFpbday, 150),
            )

        const res = await applyCoupon('FPBDAY', FRANKLIN_REC)

        expect(res.newTotal).toBe(14.36)
        expect(res.success).toBe(true)
    }, 20000)

    it('keeps a selector that is not a list exactly as before', () => {
        expect(dom.qFirstOfList('#grand')).toBe(
            document.getElementById('grand'),
        )
        expect(dom.qFirstOfList('#missing')).toBe(null)
        expect(dom.qFirstOfList('')).toBe(null)
    })

    it('falls through to a later selector when the first matches nothing', () => {
        expect(
            dom.qFirstOfList('#missing, [data-test="cart-total"] span#grand'),
        ).toBe(document.getElementById('grand'))
    })

    it('never splits inside :is(), :not(), an attribute value or a quoted string', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<p data-x="a,b" id="attr">$1.00</p><p class="t" id="is">$2.00</p>',
        )
        expect(dom.qFirstOfList('[data-x="a,b"], #grand').id).toBe('attr')
        expect(dom.qFirstOfList(':is(#nope, .t):not(.x, .y), #grand').id).toBe(
            'is',
        )
    })

    it('reads an XPath part of a mixed list, which querySelector(list) threw on', () => {
        expect(
            dom.qFirstOfList(
                "#missing, //span[@data-test='cart-price-value'][@id='grand']",
            ),
        ).toBe(document.getElementById('grand'))
        // A comma inside an XPath function call is not a list separator.
        expect(
            dom.qFirstOfList(
                "#missing, //span[contains(@data-test, 'cart-price')][@id='grand']",
            ),
        ).toBe(document.getElementById('grand'))
    })

    it('never splits inside a quoted attribute value, in either quote', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<p aria-label="Order total, USD" id="dq">$3.00</p>' +
                '<p data-label=\'Total, incl. tax\' id="sq">$4.00</p>',
        )
        expect(
            dom.qFirstOfList('[aria-label="Order total, USD"], #grand').id,
        ).toBe('dq')
        expect(
            dom.qFirstOfList("[data-label='Total, incl. tax'], #grand").id,
        ).toBe('sq')
    })
})

/* The 30 served lists that mix in an XPath part (all Shopify-family: the
 * MoneyLine CSS first, an XPath fallback after) threw inside querySelector, so
 * those stores read no total at all. Each part is now read on its own. */
describe('a Shopify list with an XPath fallback reads a total', () => {
    const SHOPIFY_XPATH_LIST =
        '[aria-labelledby^="MoneyLine-Heading"] [role="row"]:has(> [role="rowheader"] strong) > [role="cell"] strong, ' +
        "//div[@role='row'][.//strong[normalize-space()='Total']]//div[@role='cell']"
    const moneyLines = heading =>
        `<section aria-labelledby="${heading}">` +
        '<div role="row"><div role="rowheader">Subtotal</div><div role="cell">$80.00</div></div>' +
        '<div role="row"><div role="rowheader"><strong>Total</strong></div><div role="cell"><strong>$72.00</strong></div></div>' +
        '</section>'

    it('reads the MoneyLine total through the CSS part', () => {
        document.body.innerHTML = moneyLines('MoneyLine-Heading-r1')
        expect(dom.getPrice(SHOPIFY_XPATH_LIST, { returnLargest: true })).toBe(
            72,
        )
    })

    it('reads the total through the XPath part when the CSS part misses', () => {
        document.body.innerHTML = moneyLines('Summary-Heading')
        expect(dom.getPrice(SHOPIFY_XPATH_LIST, { returnLargest: true })).toBe(
            72,
        )
    })
})

/* cbd.co (WooCommerce), served config ".order-total .amount, .cart-subtotal
 * .amount": the cart totals table draws the pre-discount Subtotal row above
 * the Total row, so page order read US$30.74 on cart and checkout while the
 * order total read US$36.69 (probe 2026-11-02). A coupon never moves the
 * Subtotal. */
describe('cbd.co: the WooCommerce Total, not the Subtotal above it', () => {
    const CBD_PRICE = '.order-total .amount, .cart-subtotal .amount'
    const wooTotals = total =>
        '<div class="cart_totals"><table class="shop_table">' +
        '<tr class="cart-subtotal"><th>Subtotal</th><td><span class="woocommerce-Price-amount amount">US$30.74</span></td></tr>' +
        '<tr class="woocommerce-shipping-totals shipping"><th>Shipping</th><td><span class="woocommerce-Price-amount amount">US$5.95</span></td></tr>' +
        `<tr class="order-total"><th>Total</th><td><strong><span class="woocommerce-Price-amount amount">${total}</span></strong></td></tr>` +
        '</table></div>'

    it('reads the order total', () => {
        document.body.innerHTML = wooTotals('US$36.69')
        expect(dom.getPrice(CBD_PRICE, { returnLargest: true })).toBe(36.69)
    })

    it('sees a coupon move the order total while the Subtotal stays', () => {
        document.body.innerHTML = wooTotals('US$30.54')
        expect(dom.getPrice(CBD_PRICE, { returnLargest: true })).toBe(30.54)
    })
})

/* Page order could reach a filled element further down when the list's first
 * match was an empty skeleton or a hidden twin; list order must not lose that
 * total. The apply wait watches the same element getPrice reads. */
describe('a first match with no shown amount does not hide a later total', () => {
    it('skips an empty skeleton', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<span id="skeleton"></span>',
        )
        expect(dom.getPrice('#skeleton, #grand', { returnLargest: true })).toBe(
            17.95,
        )
        expect(dom.caramelPriceElement('#skeleton, #grand').id).toBe('grand')
    })

    it('skips a hidden twin holding a stale amount', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<span id="stale">$99.00</span>',
        )
        document.getElementById('stale').checkVisibility = () => false
        expect(dom.getPrice('#stale, #grand', { returnLargest: true })).toBe(
            17.95,
        )
    })

    it('still reads a hidden amount when nothing shown holds one', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<span id="stale">$99.00</span><span id="empty"></span>',
        )
        document.getElementById('stale').checkVisibility = () => false
        expect(dom.getPrice('#empty, #stale', { returnLargest: true })).toBe(99)
    })

    it('the apply wait watches the total getPrice reads, not the skeleton before it', async () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<span id="skeleton"></span>',
        )
        const { applyCoupon } = await import('../coupon-apply.js')
        document
            .querySelector('[data-test="redeemableEntry-submit"]')
            .addEventListener('click', () =>
                setTimeout(franklinTakesFpbday, 150),
            )
        const t0 = performance.now()

        const res = await applyCoupon('FPBDAY', {
            ...FRANKLIN_REC,
            priceContainer: '#skeleton, #grand',
            successIndicator: null,
            errorIndicator: null,
        })

        expect(res.newTotal).toBe(14.36)
        // Watching the skeleton, the wait sees no change and runs out its 10 s.
        expect(performance.now() - t0).toBeLessThan(5000)
    }, 20000)
})
