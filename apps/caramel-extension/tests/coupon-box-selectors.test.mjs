import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    caramelBoxSelectors,
    caramelOne,
    caramelRiskyControl,
    caramelSelectorAllowed,
    caramelStableSelector,
    caramelTotalSelector,
} from '../coupon-box-selectors.js'

// The coupon-box selector builder (coupon-box-selectors.js): the selectors a
// box the finder found is saved under as a store's config. These pin:
//   · a selector is built only from names a store keeps between renders, and
//     only when it finds exactly the element it names;
//   · nothing the shopper or the cart wrote (an email, a number, a price) is
//     ever part of one.

const page = html => {
    document.body.innerHTML = html
}
const $ = css => document.querySelector(css)

describe('caramelStableSelector', () => {
    beforeEach(() => page(''))

    it.each([
        ['an id', '<input id="coupon-code">', 'input#coupon-code'],
        [
            'a name',
            '<input name="discount_code">',
            'input[name="discount_code"]',
        ],
        [
            'an aria-label',
            '<input aria-label="Promo code">',
            'input[aria-label="Promo code"]',
        ],
        [
            'a placeholder',
            '<input placeholder="Enter code">',
            'input[placeholder="Enter code"]',
        ],
        [
            'a test id',
            '<input data-testid="promo-input">',
            'input[data-testid="promo-input"]',
        ],
        [
            'an id that is not a CSS identifier',
            '<input id="promo.code">',
            'input[id="promo.code"]',
        ],
    ])('names the element by %s', (_what, html, want) => {
        page(html)
        expect(caramelStableSelector($('input'))).toBe(want)
    })

    it.each([
        [':r1:', 'react useId'],
        ['ember123', 'ember'],
        ['react-select-2-input', 'react-select'],
        ['mui-12', 'mui'],
        ['a1b2c3d4e5f6', 'a hex run'],
        ['field_9921', 'a digit run'],
    ])('a generated id (%s, %s) is never the name', id => {
        page(`<input id="${id}" name="promo">`)
        expect(caramelStableSelector($('input'))).toBe('input[name="promo"]')
    })

    it.each([
        ['an email', 'me@shop.test'],
        ['a number', 'Code 12345'],
        ['a price', 'Save $5'],
    ])('a value holding %s is never part of a selector', (_what, v) => {
        page(`<input placeholder="${v}">`)
        expect(caramelStableSelector($('input'))).toBeNull()
    })

    // The server refuses these in a selector (it serves them to other
    // installs as CSS), so a name holding one is never used.
    it.each([
        ['a quote', 'say "hi"'],
        ['a backslash', 'a\\b'],
        ['a brace', 'a{b'],
        ['a semicolon', 'a;b'],
        ['an angle bracket', 'a<b'],
        ['a newline', 'a\nb'],
        ['a tab', 'a\tb'],
        ['script', 'javascript:go'],
        ['url(', 'url (x)'],
        ['expression', 'Expression'],
    ])('a value holding %s is never part of a selector', (_what, v) => {
        page('<input>')
        $('input').setAttribute('placeholder', v)
        expect(caramelStableSelector($('input'))).toBeNull()
    })

    it('every selector it builds is one the server accepts', () => {
        const REFUSED_BY_SERVER =
            /javascript:|url\s*\(|expression|[{};<\\]|\p{Cc}/iu
        page(
            '<form id="f"><div><input name="a" aria-label="x;y">' +
                '<input name="b"><button id="go.now">Go</button>' +
                '<button>Apply</button><button>Apply</button></div></form>',
        )
        const built = [...document.querySelectorAll('input,button')]
            .map(caramelStableSelector)
            .filter(Boolean)
        expect(built.length).toBeGreaterThan(3)
        for (const css of built) {
            expect(css).not.toMatch(REFUSED_BY_SERVER)
            expect(css).not.toMatch(/^[./(]/)
            expect(css.length).toBeLessThanOrEqual(256)
        }
    })

    it('a name two elements share is not used: the next one that is unique is', () => {
        page(
            '<input name="code" aria-label="Gift card">' +
                '<input name="code" aria-label="Promo code">',
        )
        const promo = document.querySelectorAll('input')[1]
        expect(caramelStableSelector(promo)).toBe(
            'input[aria-label="Promo code"]',
        )
    })

    it('a nameless element: a short path down from the nearest named ancestor', () => {
        page(
            '<form id="coupon-form"><div><input name="x" type="text">' +
                '<button>Apply</button></div></form>' +
                '<form id="other"><div><button>Apply</button></div></form>',
        )
        const sel = caramelStableSelector($('#coupon-form button'))
        expect(sel).toBe('form#coupon-form > div > button')
        expect([...document.querySelectorAll(sel)]).toEqual([
            $('#coupon-form button'),
        ])
    })

    it('a path is at most four parts: a named ancestor three steps up, and no further', () => {
        page(
            '<div id="near"><div><div><button>Apply</button></div></div></div>' +
                '<div id="far"><div><div><div><button>Apply</button></div></div></div></div>' +
                '<button>Apply</button>',
        )
        expect(caramelStableSelector($('#near button'))).toBe(
            'div#near > div > div > button',
        )
        expect(caramelStableSelector($('#far button'))).toBeNull()
    })

    it('null when nothing names it within three steps: no fragile long path', () => {
        page(
            '<div><div><div><div><div><button>Apply</button></div></div>' +
                '</div></div></div><button>Apply</button>',
        )
        expect(caramelStableSelector($('button'))).toBeNull()
    })

    it('every selector it returns finds exactly its element', () => {
        page(
            '<input name="promo"><input name="promo">' +
                '<div id="box"><input name="promo"></div>',
        )
        for (const el of document.querySelectorAll('input')) {
            const sel = caramelStableSelector(el)
            if (sel) expect([...document.querySelectorAll(sel)]).toEqual([el])
        }
        expect(caramelStableSelector($('#box input'))).toBe('div#box > input')
    })
})

// The grammar a saved box's selectors are built and read in: a selector is
// data, and only this small, cheap subset of CSS is ever queried.
describe('the saved-box selector grammar', () => {
    it.each([
        'input',
        'input#coupon-code',
        'form#promo > div > input',
        'div.cart-promo input',
        'input[name="discount_code"]',
        'input[aria-label="Promo code"]',
        'input[placeholder="Enter code"]',
        'input[type="text"]',
        'input[id="promo.code"]',
        'input[data-testid="promo-input"]',
        'button[data-qa="apply > now"]',
        'li:first-of-type > button',
        'div:nth-of-type(2) > button',
        'form#a > div > div > input',
        'div[data-a="1"] > div[name="b"] input[id="c"]',
    ])('allows %s', css => {
        expect(caramelSelectorAllowed(css)).toBe(true)
    })

    it.each([
        ['a :has()', 'div:has(input)'],
        ['a :has() deeper in', 'form > div:has(> input) input'],
        ['another pseudo-class', 'input:not([type="hidden"])'],
        [':nth-child', 'div:nth-child(2) > input'],
        ['a formula in nth-of-type', 'div:nth-of-type(2n+1)'],
        ['a pseudo-element', 'input::before'],
        ['a wildcard', '* > input'],
        ['a sibling combinator', 'label + input'],
        ['a general sibling', 'label ~ input'],
        ['an attribute outside the list', 'a[href="/x"]'],
        ['an unquoted value', 'input[name=code]'],
        ['a substring match', 'input[name*="code"]'],
        ['an escaped value', 'input[name="a\\"b"]'],
        ['an escaped id', 'input#a\\:b'],
        ['five parts', 'div#a > div > div > div > input'],
        [
            'four attribute tests',
            'div[id="a"] div[name="b"] div[type="c"] input[name="d"]',
        ],
        ['a list', 'input, button'],
        ['a leading space', ' input'],
        ['a trailing combinator', 'div >'],
        ['too long', 'input[name="' + 'a'.repeat(250) + '"]'],
        // Outside the grammar the server accepts: never built, so a save
        // is never refused for its selector.
        [
            'a value over 100 characters',
            'input[name="' + 'a'.repeat(101) + '"]',
        ],
        ['a single quote in a value', `input[name="it's"]`],
        ['a bracket in a value', 'input[name="code[0]"]'],
        ['an underscore in a data attribute name', 'input[data-test_id="x"]'],
        ['a class that starts with a hyphen and a digit', 'input.-5x'],
        ['an index over 99', 'li:nth-of-type(100) > button'],
        ['script', 'input[name="javascript:x"]'],
        ['empty', ''],
        ['not a string', 7],
    ])('refuses %s', (_what, css) => {
        expect(caramelSelectorAllowed(css)).toBe(false)
    })

    it('a refused selector is never queried', () => {
        page('<div><input name="a"></div>')
        const spy = vi.spyOn(document, 'querySelectorAll')
        expect(caramelOne(document, 'div:has(input) input')).toBeNull()
        expect(caramelOne(document, 'div > div > div > div > input')).toBeNull()
        expect(spy).not.toHaveBeenCalled()
        expect(caramelOne(document, 'div > input')).toBe($('input'))
        expect(spy).toHaveBeenCalledTimes(1)
        spy.mockRestore()
    })

    it('a selector finds exactly one element, or none', () => {
        page('<input name="code"><input name="code"><input name="promo">')
        expect(caramelOne(document, 'input[name="code"]')).toBeNull()
        expect(caramelOne(document, 'input[name="gone"]')).toBeNull()
        expect(caramelOne(document, 'input[name="promo"]')).toBe(
            document.querySelectorAll('input')[2],
        )
    })

    it('every selector the builder makes is in the grammar', () => {
        page(
            '<form id="f"><div><input name="a" aria-label="Promo code">' +
                '<input data-testid="x-1"><input placeholder="Enter code">' +
                '<button id="go.now">Go</button><div><div><span>' +
                '<button>Apply</button></span></div></div></div></form>',
        )
        const built = [...document.querySelectorAll('input,button')]
            .map(caramelStableSelector)
            .filter(Boolean)
        expect(built.length).toBeGreaterThan(3)
        for (const css of built) expect(caramelSelectorAllowed(css)).toBe(true)
    })

    // The server's personal-data rule (couponBoxSelector.ts), case for case.
    // Each selector is in the grammar once the personal data is taken out, so
    // it is that data alone that refuses it.
    it.each([
        [
            'an email in a data attribute',
            'input[data-customer-email="a@b.com"]',
            'input[data-customer-email="ab.com"]',
        ],
        [
            'an email in aria-label',
            'input[aria-label="Code for a@b.com"]',
            'input[aria-label="Code for ab.com"]',
        ],
        [
            'an encoded @',
            'input[data-user="a%40b.com"]',
            'input[data-user="ab.com"]',
        ],
        [
            'a phone number in a value',
            'input[data-phone="5551234567"]',
            'input[data-phone="55512"]',
        ],
        [
            'a phone number split by dashes',
            'input[data-phone="555-123-4567"]',
            'input[data-phone="555-12"]',
        ],
        [
            'a phone number split by dots',
            'input[data-phone="555.123.4567"]',
            'input[data-phone="555.12"]',
        ],
        [
            'a card number split by spaces',
            'input[data-card="4111 1111 1111 1111"]',
            'input[data-card="4111 1"]',
        ],
        [
            'a long number in a placeholder',
            'input[placeholder="Ref 1234567"]',
            'input[placeholder="Ref 12345"]',
        ],
    ])('refuses personal data: %s', (_what, css, clean) => {
        expect(caramelSelectorAllowed(clean)).toBe(true)
        expect(caramelSelectorAllowed(css)).toBe(false)
        page('<div><input></div>')
        const spy = vi.spyOn(document, 'querySelectorAll')
        expect(caramelOne(document, css)).toBeNull()
        expect(spy).not.toHaveBeenCalled()
        spy.mockRestore()
    })

    it.each([
        'input[data-step="12345"]',
        'input[data-price="19.99"]',
        '#promo-2024',
        'li:nth-of-type(12) input',
        'input[placeholder="Enter code (e.g. SAVE10)"]',
        // Ids and classes name an element; stores generate long numbers in
        // them, and they carry no value about the shopper. (On a tag: this
        // grammar refuses a leading "." on its own.)
        '#shopify-section-template--16712345678__main input',
        'div.acct-0012345678 input',
        'input[id="field-123456789"]',
        '#order-123456 input',
    ])('accepts short numbers, and long ones in ids and classes: %s', css => {
        expect(caramelSelectorAllowed(css)).toBe(true)
    })
})

// The server's rule for an apply or toggle selector (couponBoxSelector.ts
// isRiskyControlSelector), case for case.
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
    ])('refuses %s', css => {
        expect(caramelRiskyControl(css)).toBe(true)
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
        'form.checkout_coupon button[name="apply_coupon"]',
        'div.coupon div.purchase-summary button',
        '#checkout > div > button.apply',
        // Whole words only: PayPal is not `pay`.
        '#PayPal-apply',
        // An attribute's NAME says what data it carries, not what it does.
        'button[data-buy-box="1"]',
        // What `:not(...)` excludes is not what the element is.
        'button.apply:not(.checkout)',
        // The coupon apply in the checkout's own namespace.
        '#checkout-coupon-apply',
        '#checkout_discount_btn',
        'button[name="checkout_reduction_code_apply"]',
    ])('accepts %s', css => {
        expect(caramelRiskyControl(css)).toBe(false)
    })

    it.each([
        // The clicked element still names it, whatever its ancestors are.
        'form.coupon button.checkout',
        'div.promo > button[name="place_order"]',
    ])('refuses a risky last part behind a harmless ancestor: %s', css => {
        expect(caramelRiskyControl(css)).toBe(true)
    })
})

describe('caramelBoxSelectors', () => {
    it('names the input, the button and the toggle', () => {
        page(
            '<button id="show">Have a code?</button>' +
                '<input name="coupon"><button id="apply">Apply</button>',
        )
        expect(
            caramelBoxSelectors($('input'), $('#apply'), $('#show')),
        ).toEqual({
            input: 'input[name="coupon"]',
            apply: 'button#apply',
            toggle: 'button#show',
        })
    })

    it('a box with no button applies on Enter: no apply is named', () => {
        page('<input name="coupon">')
        expect(caramelBoxSelectors($('input'), null, null)).toEqual({
            input: 'input[name="coupon"]',
            apply: null,
            toggle: null,
        })
    })

    it('half a box is not a box: a part with no stable name names nothing', () => {
        page(
            '<input name="coupon"><button>Apply</button><button>Apply</button>',
        )
        expect(caramelBoxSelectors($('input'), $('button'), null)).toBeNull()
    })
})

describe('caramelTotalSelector', () => {
    beforeEach(() => page(''))

    it('a total row with a stable name of its own is named itself', () => {
        page(
            '<div data-testid="order-total"><span>Total</span> <span>$100.00</span></div>',
        )
        expect(caramelTotalSelector($('div'))).toBe(
            'div[data-testid="order-total"]',
        )
    })

    it('a bare row is named by the one element that holds the amount', () => {
        page(
            '<div class="item">Mug</div>' +
                '<div class="row"><span>Total</span> <span id="tot">$100.00</span></div>',
        )
        expect(caramelTotalSelector($('.row'))).toBe('span#tot')
    })

    it('a bare row with two amounts in it names nothing', () => {
        page(
            '<div class="row"><span>Total</span> <s id="was">$120.00</s> <span id="tot">$100.00</span></div>',
        )
        expect(caramelTotalSelector($('.row'))).toBeNull()
    })

    it('an amount with no stable name names nothing', () => {
        page('<div class="row"><span>Total</span> <span>$100.00</span></div>')
        expect(caramelTotalSelector($('.row'))).toBeNull()
    })
})

describe('a script-hook class (js-…) as the last name', () => {
    // bumbleandbumble.com, measured live 2026-10-22: TEXT15 took $5.25 off
    // a $35.00 bag through a box auto-detect found, and the box was never
    // saved, because the order total has no id, name or test id on it or
    // near it. Its markup, trimmed:
    const BUMBLE_TOTAL =
        '<section class="checkout-panel checkout-panel--order-total">' +
        '<header class="checkout-panel__header order-total-content clearfix">' +
        '<h2>Total</h2>' +
        '<div class="total value order-summary-content__value order-summary-content__value--total js-total-cost">$29.75</div>' +
        '</header></section>'

    it('names the bumbleandbumble.com order total by its hook class', () => {
        page(BUMBLE_TOTAL)
        expect(caramelTotalSelector($('.total'))).toBe('div.js-total-cost')
    })

    it('a row holding two amounts is still not named by its hook class', () => {
        page('<div class="js-totals"><s>$120.00</s> <span>$100.00</span></div>')
        expect(caramelTotalSelector($('div'))).toBeNull()
    })

    it('a row with a hook class and an id on its amount is named by the id', () => {
        page('<div class="js-totals"><span id="tot">$100.00</span></div>')
        expect(caramelTotalSelector($('div'))).toBe('span#tot')
    })

    it.each([
        ['a styling class', '<button class="btn apply">Apply</button>'],
        [
            'a hook class with a digit',
            '<button class="js-btn-2">Apply</button>',
        ],
        [
            'a hook class for a state',
            '<button class="js-is-active">Apply</button>',
        ],
        [
            'a hook class for visibility',
            '<button class="js-hidden">Apply</button>',
        ],
        [
            'a hook class two elements share',
            '<button class="js-apply">Apply</button><button class="js-apply">Apply</button>',
        ],
    ])('%s is no name', (_, html) => {
        page(html)
        expect(caramelStableSelector($('button'))).toBeNull()
    })

    it('a box button with only a hook class is named by it', () => {
        page('<button class="btn js-apply-offer">Apply</button>')
        expect(caramelStableSelector($('button'))).toBe('button.js-apply-offer')
    })

    it('any other name beats a hook class', () => {
        page('<button class="js-apply-offer" name="apply">Apply</button>')
        expect(caramelStableSelector($('button'))).toBe('button[name="apply"]')
    })

    it('a hook-class name is in the grammar the server accepts', () => {
        expect(caramelSelectorAllowed('div.js-total-cost')).toBe(true)
    })
})
