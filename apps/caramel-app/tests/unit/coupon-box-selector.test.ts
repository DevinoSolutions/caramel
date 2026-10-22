import { describe, expect, it } from 'vitest'

import {
    isCouponBoxSelector,
    isRiskyControlSelector,
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
        '.coupon .purchase-summary button',
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
