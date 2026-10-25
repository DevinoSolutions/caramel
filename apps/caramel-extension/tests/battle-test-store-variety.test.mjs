import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelDiscoveredRecord,
    caramelFindOrderTotal,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    TOTAL,
    handoffs,
    installChromeStub,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// The promo-box finder (auto-detect) against checkouts of many kinds: the
// big hosted platforms, self-hosted carts, custom carts, and carts in the
// languages, regions and currencies our stores ship in. Each fixture is a
// trimmed copy of the real page's structure: its field names, label words,
// summary rows and the other controls a shopper sees beside the promo box.
//
// Every store is held to the three things the apply flow needs:
//   · the pick: the promo field, and the button that applies it;
//   · the total: the row the code is judged on (no total, no auto-apply);
//   · the record: what the apply flow actually drives (caramelDiscoveredRecord).

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async () => ({ success: false, applied: false }),
    probeCartJson: async () => null,
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        log: () => {},
        sleep: async () => {},
    }
})

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = ''
    setPath('/checkout')
    _caramelResetDiscoveryFlag()
})

const idOf = sel => (sel ? document.querySelector(sel)?.id || null : null)
const textOf = sel => (sel ? document.querySelector(sel)?.textContent : null)

/* ============================================================ platforms */
// { name, html, input, button, total }: total is the amount the total row
// must show.
const PLATFORMS = [
    {
        name: 'Shopify one-page checkout',
        input: 'checkout_reduction_code',
        button: 'checkout_submit',
        total: '$34.99',
        html:
            '<div class="order-summary">' +
            '<div class="product"><span>Blue T-Shirt</span><span>$29.99</span></div>' +
            '<div class="total-line"><span>Subtotal</span><span>$29.99</span></div>' +
            '<div class="total-line"><span>Shipping</span><span>$5.00</span></div>' +
            '<div class="total-line total-line--total"><span>Total</span><span>USD $34.99</span></div>' +
            '</div>' +
            '<div class="fieldset"><div class="field">' +
            '<label for="checkout_reduction_code" class="field__label">Discount code or gift card</label>' +
            '<input id="checkout_reduction_code" name="checkout[reduction_code]" type="text" ' +
            'placeholder="Discount code or gift card" class="field__input"></div>' +
            '<button id="checkout_submit" type="submit" class="field__input-btn">Apply</button></div>' +
            '<div class="step__footer"><button type="submit">Continue to shipping</button></div>',
    },
    {
        name: 'Shopify cart drawer (Dawn theme)',
        input: 'CartDrawer-Discount',
        button: 'cart-discount-apply',
        total: '$58.00',
        html:
            '<cart-drawer class="drawer"><div class="drawer__inner">' +
            '<div class="cart-item"><span>Candle</span><span>$29.00</span>' +
            '<input type="number" name="updates[]" value="2" aria-label="Quantity for Candle"></div>' +
            '<div class="cart-drawer__footer">' +
            '<details class="cart-discount"><summary>Discount</summary>' +
            '<form><input id="CartDrawer-Discount" type="text" name="discount" placeholder="Discount code">' +
            '<button id="cart-discount-apply" type="submit">Apply</button></form></details>' +
            '<div class="totals"><h2 class="totals__total">Estimated total</h2>' +
            '<p class="totals__total-value">$58.00 USD</p></div>' +
            '<button type="submit" name="checkout">Check out</button></div>' +
            '</div></cart-drawer>',
    },
    {
        name: 'WooCommerce classic cart',
        input: 'coupon_code',
        button: 'apply_coupon',
        total: '$89.00',
        html:
            '<form class="woocommerce-cart-form"><table class="shop_table cart">' +
            '<thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Subtotal</th></tr></thead>' +
            '<tbody><tr><td>Running Shoes</td><td>$89.00</td>' +
            '<td><input type="number" name="cart[abc][qty]" value="1"></td><td>$89.00</td></tr>' +
            '<tr><td colspan="4" class="actions"><div class="coupon">' +
            '<label for="coupon_code" class="screen-reader-text">Coupon:</label>' +
            '<input type="text" name="coupon_code" class="input-text" id="coupon_code" placeholder="Coupon code">' +
            '<button type="submit" class="button" name="apply_coupon" id="apply_coupon">Apply coupon</button>' +
            '</div><button type="submit" name="update_cart">Update cart</button></td></tr>' +
            '</tbody></table></form>' +
            '<div class="cart_totals"><h2>Cart totals</h2><table>' +
            '<tr class="cart-subtotal"><th>Subtotal</th><td data-title="Subtotal">$89.00</td></tr>' +
            '<tr class="shipping"><th>Shipping</th><td>Free shipping</td></tr>' +
            '<tr class="order-total"><th>Total</th><td data-title="Total"><strong>$89.00</strong></td></tr>' +
            '</table><a href="/checkout" class="checkout-button">Proceed to checkout</a></div>',
    },
    {
        name: 'WooCommerce block checkout',
        input: 'wc-block-components-totals-coupon__input-0',
        button: 'wc-coupon-apply',
        total: '$64.50',
        html:
            '<div class="wc-block-components-totals-wrapper">' +
            '<div class="wc-block-components-totals-coupon">' +
            '<div class="wc-block-components-text-input">' +
            '<input type="text" id="wc-block-components-totals-coupon__input-0" aria-label="Enter code" autocomplete="off">' +
            '<label for="wc-block-components-totals-coupon__input-0">Enter code</label></div>' +
            '<button id="wc-coupon-apply" type="submit" class="wc-block-components-totals-coupon__button">Apply</button>' +
            '</div></div>' +
            '<div class="wc-block-components-totals-item"><span class="wc-block-components-totals-item__label">Subtotal</span>' +
            '<span class="wc-block-components-totals-item__value">$60.00</span></div>' +
            '<div class="wc-block-components-totals-item wc-block-components-totals-footer-item">' +
            '<span class="wc-block-components-totals-item__label">Total</span>' +
            '<span class="wc-block-components-totals-item__value">$64.50</span></div>' +
            '<button type="button" class="wc-block-components-checkout-place-order-button">Place Order</button>',
    },
    {
        name: 'BigCommerce optimized checkout',
        input: 'redeemableCode',
        button: 'applyRedeemableButton',
        total: '$161.00',
        html:
            '<aside class="cart-section"><div class="cart-priceItem"><span>Subtotal</span><span>$149.00</span></div>' +
            '<div class="cart-priceItem"><span>Shipping</span><span>$12.00</span></div>' +
            '<div class="redeemable-label">Coupon/Gift Certificate</div>' +
            '<div class="redeemable-entry"><input id="redeemableCode" name="redeemableCode" type="text" ' +
            'class="form-input optimizedCheckout-form-input">' +
            '<button id="applyRedeemableButton" type="button" class="button">Apply</button></div>' +
            '<div class="cart-priceItem cart-priceItem--total"><span class="cart-priceItem-label">Total (USD)</span>' +
            '<span class="cart-priceItem-value">$161.00</span></div></aside>' +
            '<button id="checkout-payment-continue" type="submit">Place Order</button>',
    },
    {
        name: 'Magento 2 Luma checkout',
        input: 'discount-code',
        button: 'mag-apply',
        total: '$235.00',
        html:
            '<div class="opc-block-summary"><table class="data table table-totals">' +
            '<tr class="totals sub"><th>Cart Subtotal</th><td>$220.00</td></tr>' +
            '<tr class="totals shipping"><th>Shipping</th><td>$15.00</td></tr>' +
            '<tr class="grand totals"><th><strong>Order Total</strong></th><td><strong>$235.00</strong></td></tr>' +
            '</table></div>' +
            '<div class="payment-option discount-code"><div class="payment-option-title"><span>Apply Discount Code</span></div>' +
            '<div class="payment-option-content"><form class="form form-discount">' +
            '<label for="discount-code" class="label"><span>Enter discount code</span></label>' +
            '<input type="text" id="discount-code" name="discount_code" class="input-text" placeholder="Enter discount code">' +
            '<button id="mag-apply" type="submit" class="action action-apply"><span>Apply Discount</span></button>' +
            '</form></div></div>' +
            '<button class="action primary checkout" type="submit">Place Order</button>',
    },
    {
        name: 'Squarespace Commerce cart',
        input: 'sqs-promo',
        button: 'sqs-promo-apply',
        total: '$42.00',
        html:
            '<div class="cart-container"><div class="cart-row"><span>Print</span><span>$40.00</span></div>' +
            '<div class="cart-summary"><div class="subtotal"><div class="subtotal-label">Subtotal</div>' +
            '<div class="subtotal-price">$40.00</div></div>' +
            '<div class="promo-code-entry"><input id="sqs-promo" type="text" aria-label="Promo code" placeholder="Promo Code">' +
            '<button id="sqs-promo-apply" type="button">Apply</button></div>' +
            '<div class="total"><div class="total-label">Total</div><div class="total-price">$42.00</div></div>' +
            '<button class="cart-checkout-button">Checkout</button></div></div>',
    },
    {
        name: 'Wix Stores cart',
        input: 'wix-coupon',
        button: 'wix-coupon-apply',
        total: '$75.00',
        html:
            '<section data-hook="cart-widget"><div data-hook="cart-widget-item"><span>Mug</span><span>$70.00</span></div>' +
            '<button data-hook="coupon-toggle" type="button">Enter a promo code</button>' +
            '<div data-hook="coupon-input"><input id="wix-coupon" data-hook="coupon-field" type="text" ' +
            'aria-label="Enter a promo code" placeholder="e.g., SAVE50">' +
            '<button id="wix-coupon-apply" data-hook="coupon-apply" type="button">Apply</button></div>' +
            '<dl data-hook="total-summary"><dt>Subtotal</dt><dd>$70.00</dd><dt>Shipping</dt><dd>$5.00</dd></dl>' +
            '<div data-hook="cart-widget-total"><span>Total</span><span>$75.00</span></div>' +
            '<button data-hook="checkout-button">Checkout</button></section>',
    },
    {
        name: 'Ecwid checkout',
        input: 'ec-coupon',
        button: 'ec-coupon-apply',
        total: '$18.50',
        html:
            '<div class="ec-cart-summary"><div class="ec-cart-summary__row"><span>Subtotal</span><span>$15.00</span></div>' +
            '<div class="ec-cart-summary__row"><span>Shipping</span><span>$3.50</span></div>' +
            '<div class="ec-cart-summary__row ec-cart-summary__row--total"><span class="ec-cart-summary__title">Total</span>' +
            '<span class="ec-cart-summary__price">$18.50</span></div></div>' +
            '<div class="ec-cart-coupon"><label for="ec-coupon">Have a discount coupon?</label>' +
            '<input id="ec-coupon" type="text" name="ec-cart-coupon__input" placeholder="Coupon code">' +
            '<button id="ec-coupon-apply" type="button">Apply</button></div>',
    },
    {
        name: 'PrestaShop 8 cart',
        input: 'ps-code',
        button: 'ps-add',
        total: '€42,90',
        html:
            '<div class="cart-summary"><div class="cart-summary-line"><span class="label">Sous-total</span><span class="value">€38,00</span></div>' +
            '<div class="cart-summary-line"><span class="label">Livraison</span><span class="value">€4,90</span></div>' +
            '<div class="cart-summary-line cart-total"><span class="label">Total TTC</span><span class="value">€42,90</span></div>' +
            '<div class="block-promo"><p class="promo-code-button">Vous avez un code promo ?</p>' +
            '<form action="/panier" method="post"><input type="hidden" name="addDiscount" value="1">' +
            '<input id="ps-code" class="promo-input" type="text" name="discount_name" placeholder="Code promo">' +
            '<button id="ps-add" type="submit" class="btn btn-primary"><span>Ajouter</span></button></form></div>' +
            '<a class="btn btn-primary" href="/commande">Commander</a></div>',
    },
    {
        name: 'OpenCart 4 cart',
        input: 'input-coupon',
        button: 'button-coupon',
        total: '£101.20',
        html:
            '<div id="accordion"><h2>Use Coupon Code</h2><div class="accordion-body">' +
            '<label for="input-coupon">Enter your coupon here</label>' +
            '<input type="text" name="coupon" id="input-coupon" placeholder="Enter your coupon here">' +
            '<button type="button" id="button-coupon">Apply Coupon</button></div></div>' +
            '<table class="table table-bordered"><tbody>' +
            '<tr><td><strong>Sub-Total:</strong></td><td>£80.00</td></tr>' +
            '<tr><td><strong>Flat Shipping Rate:</strong></td><td>£5.00</td></tr>' +
            '<tr><td><strong>VAT (20%):</strong></td><td>£16.20</td></tr>' +
            '<tr><td><strong>Total:</strong></td><td>£101.20</td></tr></tbody></table>' +
            '<a href="/checkout" class="btn">Checkout</a>',
    },
    {
        name: 'custom React cart (Next.js Commerce)',
        input: 'promo-input',
        button: 'promo-apply',
        total: '$212.00',
        html:
            '<div id="__next"><main><div class="grid"><div class="items">' +
            '<div><span>Headphones</span><span>$199.00</span><button aria-label="Remove item">×</button></div></div>' +
            '<div class="summary"><form><input id="promo-input" aria-label="Promo code" placeholder="Promo code" autocomplete="off">' +
            '<button id="promo-apply" type="submit">Apply</button></form>' +
            '<dl><div><dt>Subtotal</dt><dd>$199.00</dd></div><div><dt>Taxes</dt><dd>$13.00</dd></div>' +
            '<div><dt>Total</dt><dd>$212.00</dd></div></dl>' +
            '<button type="button">Proceed to Checkout</button></div></div></main></div>',
    },
]

describe.each(PLATFORMS)('$name', ({ html, input, button, total }) => {
    it('picks the promo field and its apply button', () => {
        document.body.innerHTML = html
        const f = caramelDiscoverCouponBox()
        expect(f.input?.id).toBe(input)
        expect(f.button?.id).toBe(button)
    })

    it('reads the total row the code is judged on', () => {
        document.body.innerHTML = html
        expect(caramelFindOrderTotal()?.textContent).toContain(total)
    })

    it('hands the apply flow a record on those same three elements', async () => {
        document.body.innerHTML = html
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec).not.toBeNull()
        expect(idOf(rec.couponInput)).toBe(input)
        expect(idOf(rec.couponSubmit)).toBe(button)
        expect(textOf(rec.priceContainer)).toContain(total)
    })
})

/* ============================================== languages and currencies */
// One cart per locale, laid out the way most small stores lay it out:
// summary rows, then a labelled promo field with its button.
function localCart({ rows, label, name, placeholder, apply }) {
    return (
        '<div class="summary">' +
        rows
            .map(
                ([l, v]) =>
                    `<div class="row"><span>${l}</span><span>${v}</span></div>`,
            )
            .join('') +
        '</div>' +
        `<div class="promo"><label for="c">${label}</label>` +
        `<input id="c" type="text" name="${name}" placeholder="${placeholder}">` +
        `<button id="b" type="button">${apply}</button></div>`
    )
}

const LOCALES = [
    {
        locale: 'Spanish (EUR)',
        total: '84,89 €',
        rows: [
            ['Subtotal', '79,90 €'],
            ['Envío', '4,99 €'],
            ['Total', '84,89 €'],
        ],
        label: 'Código de descuento',
        name: 'cupon',
        placeholder: 'Introduce tu código',
        apply: 'Aplicar',
    },
    {
        locale: 'Mexican Spanish (MXN)',
        total: '$1,249.00 MXN',
        rows: [
            ['Subtotal', '$1,150.00 MXN'],
            ['Envío', '$99.00 MXN'],
            ['Total', '$1,249.00 MXN'],
        ],
        label: 'Cupón de descuento',
        name: 'coupon',
        placeholder: 'Ingresa tu cupón',
        apply: 'Aplicar',
    },
    {
        locale: 'French (EUR)',
        total: '85,89 €',
        rows: [
            ['Sous-total', '79,90 €'],
            ['Livraison', '5,99 €'],
            ['Total TTC', '85,89 €'],
        ],
        label: 'Code promo',
        name: 'code_promo',
        placeholder: 'Entrez votre code promo',
        apply: 'Appliquer',
    },
    {
        locale: 'Canadian French (CAD)',
        total: '112,45 $',
        rows: [
            ['Sous-total', '99,00 $'],
            ['Taxes', '13,45 $'],
            ['Total', '112,45 $'],
        ],
        label: 'Code de réduction',
        name: 'reduction',
        placeholder: 'Code',
        apply: 'Appliquer',
    },
    {
        locale: 'German (EUR)',
        total: '1.234,56 €',
        rows: [
            ['Zwischensumme', '1.229,57 €'],
            ['Versand', '4,99 €'],
            ['Gesamtsumme', '1.234,56 €'],
        ],
        label: 'Gutscheincode',
        name: 'gutschein',
        placeholder: 'Gutscheincode eingeben',
        apply: 'Einlösen',
    },
    {
        locale: 'Swiss German (CHF)',
        total: "CHF 1'249.90",
        rows: [
            ['Zwischensumme', "CHF 1'240.00"],
            ['Versand', 'CHF 9.90'],
            ['Total', "CHF 1'249.90"],
        ],
        label: 'Rabattcode',
        name: 'rabatt',
        placeholder: 'Rabattcode',
        apply: 'Anwenden',
    },
    {
        locale: 'Swiss French (CHF, spaced rows)',
        total: "CHF 2'480.00",
        rows: [
            ['Sous-total ', "CHF 2'450.00"],
            ['Livraison ', 'CHF 30.00'],
            ['Total ', "CHF 2'480.00"],
        ],
        label: 'Code de réduction',
        name: 'code',
        placeholder: 'Code',
        apply: 'Appliquer',
    },
    {
        locale: 'Italian (EUR)',
        total: '€ 85,89',
        rows: [
            ['Subtotale', '€ 79,90'],
            ['Spedizione', '€ 5,99'],
            ['Totale', '€ 85,89'],
        ],
        label: 'Codice sconto',
        name: 'codice_sconto',
        placeholder: 'Inserisci il codice',
        apply: 'Applica',
    },
    {
        locale: 'Dutch (EUR)',
        total: '€ 85,89',
        rows: [
            ['Subtotaal', '€ 79,90'],
            ['Verzending', '€ 5,99'],
            ['Totaal', '€ 85,89'],
        ],
        label: 'Kortingscode',
        name: 'kortingscode',
        placeholder: 'Voer je kortingscode in',
        apply: 'Toepassen',
    },
    {
        locale: 'Brazilian Portuguese (BRL)',
        total: 'R$ 214,90',
        rows: [
            ['Subtotal', 'R$ 199,90'],
            ['Frete', 'R$ 15,00'],
            ['Total', 'R$ 214,90'],
        ],
        label: 'Cupom de desconto',
        name: 'cupom',
        placeholder: 'Insira seu cupom',
        apply: 'Aplicar',
    },
    {
        locale: 'Polish (PLN)',
        total: '214,90 zł',
        rows: [
            ['Wartość produktów', '199,90 zł'],
            ['Dostawa', '15,00 zł'],
            ['Razem', '214,90 zł'],
        ],
        label: 'Kod rabatowy',
        name: 'kupon',
        placeholder: 'Wpisz kod rabatowy',
        apply: 'Zastosuj',
    },
    {
        locale: 'Swedish (SEK)',
        total: '848 kr',
        rows: [
            ['Delsumma', '799 kr'],
            ['Frakt', '49 kr'],
            ['Totalt', '848 kr'],
        ],
        label: 'Rabattkod',
        name: 'rabattkod',
        placeholder: 'Ange rabattkod',
        apply: 'Använd',
    },
    {
        locale: 'Finnish (EUR)',
        total: '64,90 €',
        rows: [
            ['Välisumma', '59,90 €'],
            ['Toimitus', '5,00 €'],
            ['Yhteensä', '64,90 €'],
        ],
        label: 'Alennuskoodi',
        name: 'alennus',
        placeholder: 'Syötä alennuskoodi',
        apply: 'Käytä',
    },
    {
        locale: 'Japanese (JPY)',
        total: '¥4,480',
        rows: [
            ['小計', '¥3,980'],
            ['送料', '¥500'],
            ['合計', '¥4,480'],
        ],
        label: 'クーポンコード',
        name: 'coupon',
        placeholder: 'クーポンコードを入力',
        apply: '適用',
    },
    {
        locale: 'British English (GBP)',
        total: '£54.99',
        rows: [
            ['Subtotal', '£49.99'],
            ['Delivery', '£5.00'],
            ['Total to pay', '£54.99'],
        ],
        label: 'Promo code',
        name: 'promo',
        placeholder: 'Enter promo code',
        apply: 'Apply',
    },
    {
        locale: 'Indian English (INR)',
        total: '₹2,499',
        rows: [
            ['Bag total', '₹2,999'],
            ['Bag discount', '-₹500'],
            ['Total amount', '₹2,499'],
        ],
        label: 'Apply coupon',
        name: 'coupon_code',
        placeholder: 'Enter coupon code',
        apply: 'Apply',
    },
    {
        locale: 'Australian English (AUD)',
        total: 'A$89.95',
        rows: [
            ['Subtotal', 'A$79.95'],
            ['Shipping', 'A$10.00'],
            ['Total (incl. GST)', 'A$89.95'],
        ],
        label: 'Discount code',
        name: 'discount',
        placeholder: 'Discount code',
        apply: 'Apply',
    },
]

describe.each(LOCALES)('$locale cart', c => {
    it('picks the promo field and its apply button', () => {
        document.body.innerHTML = localCart(c)
        const f = caramelDiscoverCouponBox()
        expect(f.input?.id).toBe('c')
        expect(f.button?.id).toBe('b')
    })

    it('reads the total row', () => {
        document.body.innerHTML = localCart(c)
        expect(caramelFindOrderTotal()?.textContent).toContain(c.total)
    })

    it('hands the apply flow a record', async () => {
        document.body.innerHTML = localCart(c)
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec).not.toBeNull()
        expect(idOf(rec.couponInput)).toBe('c')
        expect(textOf(rec.priceContainer)).toContain(c.total)
    })
})

/* ============================================================ total rows */
describe('total rows that must be read', () => {
    const BOX =
        '<div><label for="dc">Promo code</label>' +
        '<input id="dc" type="text"><button>Apply</button></div>'
    it.each([
        ['Amount Due', '$54.00'],
        ['Order total', '$54.00'],
        ['Grand Total', '$54.00'],
        ['Estimated Total', '$54.00'],
        ['Total (incl. VAT)', '€ 119,90'],
        ['Gesamt', '€ 85,89'],
        ['Summe', '€ 85,89'],
        ['Totale', '€ 85,89'],
        ['合計', '¥4,480'],
    ])('"%s"', (label, amount) => {
        document.body.innerHTML =
            BOX +
            `<div><span>Subtotal</span><span>${amount}</span></div>` +
            `<div><span>${label}</span><span>${amount}</span></div>`
        const t = caramelFindOrderTotal()
        expect(t?.textContent).toContain(label)
    })

    it('a "Total" column heading over line totals is not the order total', () => {
        document.body.innerHTML =
            BOX +
            '<table><thead><tr><th>Product</th><th>Total</th></tr></thead><tbody>' +
            '<tr><td>Shirt</td><td>$25.00</td></tr><tr><td>Pants</td><td>$40.00</td></tr>' +
            '</tbody></table>' +
            '<div class="order-total"><span>Total</span><span>$65.00</span></div>'
        expect(caramelFindOrderTotal()?.textContent).toContain('$65.00')
    })
})

/* ============================================ never the coupon box */
describe('fields beside a promo heading that are never typed into', () => {
    it.each([
        [
            'a gift card balance checker',
            '<div class="gift-check"><h3>Check Gift Card Balance</h3>' +
                '<label for="x">Gift card number</label>' +
                '<input id="x" type="text" name="giftcard_number">' +
                '<button id="y">Check Balance</button></div>',
        ],
        [
            'a reward points field with its own Apply',
            '<div class="rewards"><h3>Use your reward points</h3>' +
                '<label for="x">Points to redeem</label>' +
                '<input id="x" type="text" name="reward_points" placeholder="Enter points">' +
                '<button id="y">Apply</button></div>',
        ],
        [
            'a membership number under "Member discount"',
            '<div class="member"><h3>Member discount</h3>' +
                '<label for="x">Membership number</label>' +
                '<input id="x" type="text" name="membership_number">' +
                '<button id="y">Apply</button></div>',
        ],
        [
            'a newsletter email under "special offers and promotions"',
            '<div class="newsletter"><h3>Get special offers and promotions</h3>' +
                '<input id="x" type="text" name="email" placeholder="Enter your email">' +
                '<button id="y">Subscribe</button></div>',
        ],
        [
            'a gift message under a "Promotional gift" heading',
            '<div class="gift"><h3>Promotional gift wrap</h3>' +
                '<label for="x">Gift message</label>' +
                '<input id="x" type="text" name="gift_message">' +
                '<button id="y">Save</button></div>',
        ],
        [
            'a store-credit amount field',
            '<div class="credit"><h3>Store credit: $25.00 available</h3>' +
                '<label for="x">Amount of store credit to use</label>' +
                '<input id="x" type="text" name="store_credit_amount">' +
                '<button id="y">Apply</button></div>',
        ],
        [
            'a one-time verification code under "Promo"',
            '<div class="verify"><h3>Verify to unlock your promo</h3>' +
                '<label for="x">Verification code</label>' +
                '<input id="x" type="text" name="otp" autocomplete="one-time-code">' +
                '<button id="y">Verify</button></div>',
        ],
    ])('%s', async (_name, html) => {
        document.body.innerHTML = html + TOTAL
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        // Nothing the apply flow could type a code into or click.
        expect(idOf(rec?.couponInput)).not.toBe('x')
        expect(idOf(rec?.couponSubmit)).not.toBe('y')
    })

    it('a login form on the checkout gives no box at all', () => {
        document.body.innerHTML =
            '<form class="login"><label for="user">Username</label><input id="user" type="text" name="username">' +
            '<label for="pw">Password</label><input id="pw" type="password" name="password">' +
            '<button>Log in</button></form>' +
            TOTAL
        expect(caramelDiscoverCouponBox().input).toBeNull()
    })
})

/* ======================================== a full checkout, every field */
describe('a full one-page checkout with every other field a store asks for', () => {
    const FULL =
        '<form class="shipping"><h2>Shipping</h2>' +
        [
            'firstname',
            'lastname',
            'email',
            'phone',
            'address',
            'city',
            'state',
            'zipcode',
            'company',
        ]
            .map(
                n =>
                    `<label for="${n}">${n}</label><input id="${n}" type="text" name="${n}">`,
            )
            .join('') +
        '</form>' +
        '<div class="promo-section"><label for="pc">Promo code</label>' +
        '<input id="pc" type="text" name="promo_code" placeholder="Enter promo code">' +
        '<button id="apply-promo">Apply</button></div>' +
        '<div class="payment"><h2>Payment</h2>' +
        '<label for="cn">Card number</label><input id="cn" type="text" name="card_number" autocomplete="cc-number">' +
        '<label for="ex">Expiry</label><input id="ex" type="text" name="expiry">' +
        '<label for="cv">CVV</label><input id="cv" type="text" name="cvv"></div>' +
        '<div class="summary"><div><span>Subtotal</span><span>$150.00</span></div>' +
        '<div><span>Tax</span><span>$12.00</span></div><div><span>Total</span><span>$162.00</span></div></div>' +
        '<button class="checkout-btn">Place Order</button>'

    it('picks the promo field and Apply out of a dozen fields and Place Order', async () => {
        document.body.innerHTML = FULL
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(idOf(rec?.couponInput)).toBe('pc')
        expect(idOf(rec?.couponSubmit)).toBe('apply-promo')
        expect(textOf(rec?.priceContainer)).toContain('$162.00')
    })
})
