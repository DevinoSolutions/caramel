import { describe, expect, it } from 'vitest'

import {
    isCouponBoxSelector,
    isRiskyControlSelector,
    namesCouponControl,
} from '@/lib/couponBoxSelector'

// The coupon box selector grammar (src/lib/couponBoxSelector.ts), the
// contract the extension emits against: what it must accept, and what a saved
// box may never smuggle in.

describe('coupon box selector grammar', () => {
    it.each([
        '#promo',
        '.promo-code',
        'input#promo.coupon',
        'input[name="promo"]',
        'input[name=promo]',
        'input[placeholder="Code promo"]',
        'input[aria-label="Discount code"]',
        'input[type="text"][name^="disc"]',
        'button[data-testid="apply-coupon"]',
        'input[id$="-code"]',
        'input[name*="coupon"]',
        '[data-action]',
        'form#cart > input[name="code"]',
        'div.promo input',
        'form .row > div input',
        'button.apply:not(.disabled)',
        '.-x-promo',
        '#_code',
        'input[name=""]',
        'label + input#code',
        'li:first-child > input[name="code"]',
        'tr:nth-child(12) button.apply',
        'input.code:not([type="hidden"])',
        'form#cart button:last-of-type',
    ])('accepts %s', selector => {
        expect(isCouponBoxSelector(selector)).toBe(true)
    })

    it.each([
        ['empty', ''],
        // No id, class or attribute outside :not(): names an element by tag
        // and position alone (the site search, for `input`).
        ['a bare type', 'input'],
        ['the universal selector', '*'],
        ['a type path', 'div > input'],
        ['a sibling path', 'label + input'],
        ['positions only', 'li:nth-of-type(2) input'],
        ['an attribute only inside :not', 'input:not([type="hidden"])'],
        ['a pseudo-class only', '*:first-child'],
        ['too long', `#${'a'.repeat(256)}`],
        ['a selector list', '#a, #b'],
        [':has(', 'form:has(input)'],
        [':not(:has(', 'input:not(:has(span))'],
        [':not( with two items', 'input:not(.a.b)'],
        [':not( with a pseudo-class', 'input:not(:first-child)'],
        [':nth-last-child', 'input:nth-last-child(1)'],
        [':nth-last-of-type', 'input:nth-last-of-type(1)'],
        [':nth-child(odd)', 'li:nth-child(odd)'],
        [':nth-child(2n+1)', 'li:nth-child(2n+1)'],
        [':nth-child(0)', 'li:nth-child(0)'],
        ['an unlisted pseudo-class', 'input:focus'],
        ['a pseudo-element', 'input::before'],
        ['href', 'a[href="/apply"]'],
        ['style', 'input[style="display:none"]'],
        ['class attribute', 'div[class="promo"]'],
        ['value attribute', 'input[value="SAVE10"]'],
        ['an upper-case data attribute', 'input[data-Test="x"]'],
        ['the ~= operator', 'input[name~="code"]'],
        ['the |= operator', 'input[name|="code"]'],
        ['a case flag', 'input[name="code" i]'],
        ['a space inside brackets', 'input[ name="code"]'],
        ['a single-quoted value', "input[name='code']"],
        ['a quote inside a value', `input[name="it's"]`],
        ['a backslash', '#\\31 23'],
        ['a bracket inside a value', 'input[name="a]b"]'],
        ['a value over 100 characters', `input[name="${'a'.repeat(101)}"]`],
        [
            'four attribute selectors',
            'input[id="a"][name="b"][type="c"][placeholder="d"]',
        ],
        [
            'four attributes counting :not',
            'input[id="a"][name="b"][type="c"]:not([placeholder="d"])',
        ],
        ['five compounds', 'main form div label input'],
        ['a trailing combinator', 'form >'],
        ['a leading combinator', '> input'],
        ['javascript:', 'input[name="javascript:x"]'],
        ['url(', 'input[name="url(x)"]'],
        ['expression', 'input[name="expression"]'],
        ['an id starting with a digit', '#1code'],
        ['XPath', '//input'],
        ['a tab', 'form\tinput'],
        ['a newline', 'form\ninput'],
        ['a comment', 'input/* x */'],
    ])('refuses %s', (_, selector) => {
        expect(isCouponBoxSelector(selector)).toBe(false)
    })

    // A store's markup can carry the shopper's own data; a box location must
    // never hold it (the privacy policy says so).
    it.each([
        [
            'an email in a data attribute',
            'input[data-customer-email="a@b.com"]',
        ],
        ['an email in aria-label', 'input[aria-label="Code for a@b.com"]'],
        ['an encoded @', 'input[data-user="a%40b.com"]'],
        ['a phone number in a value', 'input[data-phone="5551234567"]'],
        ['a phone number split by dashes', 'input[data-phone="555-123-4567"]'],
        ['a phone number split by dots', 'input[data-phone="555.123.4567"]'],
        [
            'a card number split by spaces',
            'input[data-card="4111 1111 1111 1111"]',
        ],
        ['a number in an unquoted value', 'input[data-order=n-555-123-4567]'],
        ['a long number in a placeholder', 'input[placeholder="Ref 1234567"]'],
    ])('refuses personal data: %s', (_, selector) => {
        expect(isCouponBoxSelector(selector)).toBe(false)
    })

    it.each([
        'input[data-step="12345"]',
        'input[data-price="19.99"]',
        '#promo-2024',
        'ul.cart li:nth-child(12) input',
        'input[placeholder="Enter code (e.g. SAVE10)"]',
        // Ids and classes name an element; stores generate long numbers in
        // them, and they carry no value about the shopper.
        '#shopify-section-template--16712345678__main input',
        '.acct-0012345678 input',
        'input[id="field-123456789"]',
    ])(
        'accepts short numbers, and long ones in ids and classes: %s',
        selector => {
            expect(isCouponBoxSelector(selector)).toBe(true)
        },
    )
})

describe('apply and toggle selectors that name a risky control', () => {
    it.each([
        '#checkout-button',
        'button[name="checkout"]',
        '#place-order',
        '.place_order',
        'button[data-testid="placeOrder"]',
        'button[data-action="submit-order"]',
        '#submitOrder',
        'button.pay',
        'button[aria-label="Pay now"]',
        '#paynow',
        'button[name="buy"]',
        '.buy-now',
        '#purchase',
        'button[data-action="delete"]',
        'button[aria-label="Remove item"]',
        '.remove-coupon',
        // `checkout` with no coupon word, or beside another risky word.
        '#checkout_submit',
        'button[name=checkout]',
        '#checkout-pay',
        '#checkout-coupon-remove',
    ])('refuses %s', selector => {
        expect(isRiskyControlSelector(selector)).toBe(true)
    })

    it.each([
        'button[name="apply-promo"]',
        '#apply-coupon',
        'button[data-testid="apply-discount"]',
        '.promo-toggle',
        'button[aria-label="Apply"]',
        'a.display-promo',
        'button[data-action="payload-free"]',
        'button.buyer-promo',
        // Only the element that is clicked is read, never its ancestors:
        // WooCommerce's own apply button, inside its checkout_coupon form.
        'form.checkout_coupon button[name=apply_coupon]',
        '.coupon .purchase-summary button.apply',
        '#checkout > div > button.apply',
        // Whole words only: PayPal is not `pay`.
        '#PayPal-apply',
        // An attribute's NAME says what data it carries, not what it does.
        'button[data-buy-box]',
        // What `:not(...)` excludes is not what the element is.
        'button.apply:not(.checkout)',
        // The coupon apply in the checkout's own namespace.
        '#checkout-coupon-apply',
        '#checkout_discount_btn',
        'button[name="checkout_reduction_code_apply"]',
    ])('accepts %s', selector => {
        expect(isRiskyControlSelector(selector)).toBe(false)
    })

    it.each([
        // The clicked element still names it, whatever its ancestors are.
        'form.coupon button.checkout',
        '.promo > button[name="place_order"]',
    ])(
        'refuses a risky last compound behind a harmless ancestor: %s',
        selector => {
            expect(isRiskyControlSelector(selector)).toBe(true)
        },
    )
})

// T-6221: a selector that is not worded like a checkout can still click a
// button that submits the form (Place Order on a one-page checkout).
describe('apply and toggle selectors that can submit a form', () => {
    it.each([
        // The submit controls themselves.
        'button[type=submit]',
        'button[type="submit"]',
        'button[type=SUBMIT]',
        'input[type=submit]',
        'input[type="submit"]',
        'input[type=image]',
        '.cart__footer button[type=submit]',
        'form.coupon button.apply[type=submit]',
        // Any type test that is not exactly `button` or `reset`.
        'button[type]',
        'button[type^=sub]',
        'button[type*=ubm]',
        'button[type$=mit]',
        'button.go[type=reset-all]',
        // Form-submission attributes (outside the grammar, refused anyway).
        'button[form]',
        'button[form="checkout"]',
        'button[formaction]',
        'button[formaction="/pay"]',
        'input[formmethod=post]',
        // A bare submit-capable tag, whatever its ancestors say.
        '.cart__footer button',
        '#checkout-form input',
        '.promo > button',
        'button:first-of-type',
        'form.coupon button:nth-of-type(2)',
        '.promo *',
        // Spelled in pieces, or joined, so no whole word is risky.
        '[aria-label*=heckout]',
        '[id^=check][id$=out]',
        'button[id^=check][id$=out]',
        'button[name*=laceord]',
        'button[data-action*=ubmit]',
        '#checkoutButton',
        'button.btn_placeOrder',
        'button[data-testid="submitOrder"]',
        'button[data-complete-order]',
        // An attribute NAME that says what the control does.
        'button[data-place-order]',
        'button[data-checkout-button]',
    ])('refuses %s', selector => {
        expect(isRiskyControlSelector(selector)).toBe(true)
    })

    it.each([
        'button[type=button].apply',
        'button.apply[type="button"]',
        'button[type=reset].clear-promo',
        'button[name="apply_coupon"]',
        'input[name="apply_coupon"]',
        '.cart__footer button.apply-code',
        'form.coupon button:not(.go).apply',
        // A partial test whose value is no piece of a risky term.
        'button[id^=promo]',
        'button[id$=-apply]',
        'button[name*=coupon]',
        'button[aria-label*=Apply]',
        // Names that merely contain a short risky word inside another word.
        'button.display-code',
        'a#buyer-code-toggle',
    ])('accepts %s', selector => {
        expect(isRiskyControlSelector(selector)).toBe(false)
    })
})

// T-6221 (review): the denylist alone passes any generic selector
// (`button.btn` clicks the first .btn on a checkout). An apply or toggle
// selector must ALSO name a coupon, so the save accepts a selector only when
// both gates agree.
const acceptedForClick = (selector: string) =>
    isCouponBoxSelector(selector) &&
    namesCouponControl(selector) &&
    !isRiskyControlSelector(selector)

describe('apply and toggle selectors must name a coupon (allowlist) as well as pass the denylist', () => {
    it.each([
        // Generic selectors the denylist alone let through (T-6221 review).
        '.btn',
        'button.btn',
        '.cart__footer .button',
        '[name=commit]',
        '[name=complete]',
        '.btn[aria-label="Continue to payment"]',
        'a.btn',
        '[data-x*=ayment]',
        '#p-a-y',
        '.btn[data-submit]',
        // More of the same shape.
        'button[name=continue]',
        '#submit-btn',
        'input[type=button].go',
        'button.primary',
        '.checkout-footer .action',
        // The coupon word is only an ANCESTOR, or only excluded by :not().
        '.promo-box button.btn',
        'button.btn:not(.promo)',
        // A coupon word hiding inside another word is not a coupon word.
        '#zipcode-go',
        '.barcode-scan',
        'button.reapply-later',
        // A tag named like a coupon word does not count; only the name does.
        'code.x',
    ])('refuses %s', selector => {
        expect(acceptedForClick(selector)).toBe(false)
    })

    it.each([
        // Real-looking apply and toggle controls.
        'button[name="apply_coupon"]',
        'form.coupon button[name=apply_coupon]',
        'button[name="checkout_reduction_code_apply"]',
        '#checkout-coupon-apply',
        '#checkout_discount_btn',
        '#applyCouponBtn',
        'button#ApplyPromoCode',
        'button.js-apply-voucher',
        'button[data-testid="apply-promo-code"]',
        '[data-testid="coupon-apply-button"]',
        'button[aria-label="Apply discount code"]',
        'button[aria-label="Redeem gift card"]',
        'button[aria-label="Apply"]',
        'input[name="apply_coupon"]',
        '.promo-code__submit',
        '.cart-coupon .apply-code',
        'button.reveal-promo',
        'a[data-promo-toggle]',
        'button.display-code',
        'a#buyer-code-toggle',
        'button[id^=promo]',
        'button[id$=-apply]',
        'button[name*=coupon]',
        'button.apply[type="button"]',
        '#PayPal-apply',
    ])('accepts %s', selector => {
        expect(acceptedForClick(selector)).toBe(true)
    })

    it.each([
        '#apply-payment',
        '[data-complete-promo]',
        '[data-apply-order]',
        '[data-coupon-order]',
        '[aria-label="Gift card payment"]',
        'button.applyPayment',
        'button.coupon-complete',
        // A coupon word does not exempt these (only `checkout` has that).
        '#checkout-coupon-order',
    ])('refuses payment / order / complete in a name: %s', selector => {
        expect(isRiskyControlSelector(selector)).toBe(true)
        expect(acceptedForClick(selector)).toBe(false)
    })

    it.each([
        // `submit` alone stays allowed: a real apply button.
        '#promo-code-submit',
        'button.coupon-submit',
        'button[data-testid="apply-promo-submit"]',
    ])('still accepts a submit-named coupon control: %s', selector => {
        expect(acceptedForClick(selector)).toBe(true)
    })

    it('a coupon word does not rescue a control the denylist refuses', () => {
        for (const selector of [
            'button.apply[type=submit]',
            '#apply-and-pay',
            'button.promo-code.place-order',
            'input.coupon[type=image]',
            'button[data-promo][form]',
        ]) {
            expect(namesCouponControl(selector)).toBe(true)
            expect(acceptedForClick(selector)).toBe(false)
        }
    })
})
