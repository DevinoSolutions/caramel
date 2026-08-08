import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// The guard that stands between a drifted store config and the user's money.
//
// A four-agent QA sweep on 2026-08-05 placed real orders in a browser through
// FOUR separate paths, none of which the guard as written could see:
//   1. an icon order button labelled by <img alt>, aria-labelledby or title=
//      — the guard read only innerText/aria-label/value/name/id, and an icon
//      button has nothing in any of those;
//   2. a NON-ENGLISH order button ("Jetzt kaufen", "Commander et payer") —
//      manifest.json matches https://*./*, so every locale is in scope;
//   3. an apply button of type="submit" inside the checkout's own <form>,
//      whose visible label legitimately reads "Apply Discount" — no label test
//      can ever catch that one;
//   4. the Enter keydown the apply path used to dispatch unconditionally,
//      which submits whatever form the coupon input lives in. The guard was
//      only ever consulted for elements about to be CLICKED, so this bypassed
//      it entirely and fired once per code.
//
// 1 and 2 are gaps in WHAT the guard reads; 3 and 4 are a gap in WHAT it
// guards — the dangerous thing is the form being submitted, not the element
// being touched. caramelFormSubmitIsUnsafe covers the second kind.
//
// Direction of failure is deliberate: refusing wrongly costs the user a
// discount, allowing wrongly costs them an order they never placed.

let doc
let caramelIsForbiddenControl
let caramelFormSubmitIsUnsafe
let caramelCouponAnchors

beforeAll(() => {
    ;({
        caramelIsForbiddenControl,
        caramelFormSubmitIsUnsafe,
        caramelCouponAnchors,
    } = loadExtensionSources(
        ['caramel-base.js', 'dom-utils.js'],
        [
            'caramelIsForbiddenControl',
            'caramelFormSubmitIsUnsafe',
            'caramelCouponAnchors',
        ],
    ))
})

beforeEach(() => {
    document.body.innerHTML = ''
    doc = document
})

// jsdom performs no layout, so _isVisible's two signals both fail closed:
// checkVisibility() does not exist and offsetParent is always null, making
// EVERY element invisible. Without this the over-broad cases below would pass
// for the wrong reason — an empty result proving nothing — and the "one promo
// control is fine" cases could never pass at all. Implement just enough of
// checkVisibility for the only distinction these tests draw: display:none on
// the element or an ancestor.
beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = function checkVisibility() {
        for (let el = this; el && el.style; el = el.parentElement)
            if (el.style.display === 'none') return false
        return true
    }
})

/** Build markup and hand back the element under test. */
function mount(html, sel) {
    doc.body.innerHTML = html
    return doc.querySelector(sel)
}

describe('caramelIsForbiddenControl — how the control is labelled', () => {
    it('refuses an icon button whose only label is its image alt text', () => {
        const btn = mount(
            '<button id="cta-primary"><img alt="Place order" src="x"></button>',
            '#cta-primary',
        )
        expect(caramelIsForbiddenControl(btn)).toBe(true)
    })

    it('refuses an icon button labelled through aria-labelledby', () => {
        const btn = mount(
            '<span id="lbl">Place order</span><button id="cta-primary" aria-labelledby="lbl"></button>',
            '#cta-primary',
        )
        expect(caramelIsForbiddenControl(btn)).toBe(true)
    })

    it('refuses a button whose only label is its title attribute', () => {
        const btn = mount(
            '<button id="cta-primary" title="Place order"></button>',
            '#cta-primary',
        )
        expect(caramelIsForbiddenControl(btn)).toBe(true)
    })

    it('still refuses the labelling shapes that already worked', () => {
        // Guards the guard: the widened extraction must not have dropped
        // anything the narrower version caught.
        expect(
            caramelIsForbiddenControl(
                mount('<button id="b">Place Order</button>', '#b'),
            ),
        ).toBe(true)
        expect(
            caramelIsForbiddenControl(
                mount(
                    '<button id="place-order-btn"></button>',
                    '#place-order-btn',
                ),
            ),
        ).toBe(true)
        expect(
            caramelIsForbiddenControl(
                mount('<input id="b" type="submit" value="Pay now">', '#b'),
            ),
        ).toBe(true)
    })

    it('refuses order buttons in the languages our store list actually reaches', () => {
        for (const label of [
            'Jetzt kaufen',
            'Commander et payer',
            'Payer maintenant',
            'Realizar pedido',
            'Finalizar compra',
            'Procedi al pagamento',
        ]) {
            const btn = mount(`<button id="b">${label}</button>`, '#b')
            expect(
                caramelIsForbiddenControl(btn),
                `"${label}" must be refused`,
            ).toBe(true)
        }
    })

    it('refuses controls that destroy the cart or the session', () => {
        for (const label of [
            'Empty Cart',
            'Clear bag',
            'Log out',
            'Sign out',
        ]) {
            const btn = mount(`<button id="b">${label}</button>`, '#b')
            expect(
                caramelIsForbiddenControl(btn),
                `"${label}" must be refused`,
            ).toBe(true)
        }
    })

    it('still allows the coupon controls it exists to let through', () => {
        // The whole guard is worthless if it swallows legitimate targets: a
        // coupon apply button is never called "Pay now".
        for (const label of [
            'Apply',
            'Apply Discount',
            'Apply Coupon',
            'Submit',
            'Use code',
            'Redeem',
            'Add promo code',
        ]) {
            const btn = mount(`<button id="b">${label}</button>`, '#b')
            expect(
                caramelIsForbiddenControl(btn),
                `"${label}" must be allowed`,
            ).toBe(false)
        }
    })

    it('is not tripped by a malformed aria-labelledby reference', () => {
        const btn = mount(
            '<button id="b" aria-labelledby="does-not-exist">Apply</button>',
            '#b',
        )
        expect(caramelIsForbiddenControl(btn)).toBe(false)
    })
})

describe('caramelFormSubmitIsUnsafe — what the action would submit', () => {
    it('refuses a form carrying the card number, however innocent the button reads', () => {
        // The proven path: apply button of type="submit" inside the checkout
        // form. Its label is legitimately "Apply Discount", so only the form
        // can give it away.
        const btn = mount(
            `<form id="checkout">
                <input name="promo">
                <input autocomplete="cc-number" name="cardnum">
                <button id="apply" type="submit">Apply Discount</button>
            </form>`,
            '#apply',
        )
        expect(caramelIsForbiddenControl(btn)).toBe(false)
        expect(caramelFormSubmitIsUnsafe(btn)).toBe(true)
    })

    it('refuses a form containing an order button, reached from the coupon input', () => {
        // The Enter-key path: the input is innocent, the form is not.
        const input = mount(
            `<form id="order-form">
                <input id="gift-note" name="note">
                <button id="submit-order">Place order</button>
            </form>`,
            '#gift-note',
        )
        expect(caramelFormSubmitIsUnsafe(input)).toBe(true)
    })

    it('allows a dedicated coupon form — the shape real configs target', () => {
        // Magento's #discount-coupon-form and WooCommerce's .checkout_coupon
        // are their own forms and carry neither payment fields nor an order
        // button. Widening the guard must not go dark on working stores.
        const input = mount(
            `<form id="discount-coupon-form">
                <input id="coupon_code" name="coupon_code">
                <button data-action="apply-coupon">Apply Discount</button>
            </form>`,
            '#coupon_code',
        )
        expect(caramelFormSubmitIsUnsafe(input)).toBe(false)
    })

    it('allows a coupon input with no owning form at all', () => {
        // No form means there is no implicit submission to worry about.
        const input = mount('<input id="promo" name="promo">', '#promo')
        expect(caramelFormSubmitIsUnsafe(input)).toBe(false)
    })

    it('detects the card field by name when autocomplete is absent', () => {
        const btn = mount(
            `<form>
                <input name="cardNumber">
                <button id="apply">Apply</button>
            </form>`,
            '#apply',
        )
        expect(caramelFormSubmitIsUnsafe(btn)).toBe(true)
    })

    it('sees an order button labelled the accessible way inside the form', () => {
        // Composes the two halves: the form check is only as good as the label
        // check it delegates to.
        const input = mount(
            `<form>
                <input id="promo" name="promo">
                <button id="pay"><img alt="Place order" src="x"></button>
            </form>`,
            '#promo',
        )
        expect(caramelFormSubmitIsUnsafe(input)).toBe(true)
    })

    it('returns false for a null element rather than throwing', () => {
        expect(caramelFormSubmitIsUnsafe(null)).toBe(false)
    })
})

describe('caramelCouponAnchors — a selector too broad to mean anything', () => {
    // Measured live on mejuri.com (QA sweep 2026-08-05): the served config's
    // showInput contains the clause `button:has(> *)`, which matched 48 visible
    // elements on the homepage and 389 on a category page. Checkout detection
    // therefore answered "yes" on every page of the site. That store is saved
    // today only by having no coupons in the database — the first code scraped
    // for it would put the prompt on every product and category page.

    /** n visible buttons, as an over-broad selector would resolve to. */
    const manyButtons = n =>
        Array.from(
            { length: n },
            (_, i) => `<button id="b${i}">x</button>`,
        ).join('')

    it('returns the matches for a selector aimed at one promo control', () => {
        mount(
            '<button id="promo-toggle">Apply Promo Code</button>',
            '#promo-toggle',
        )
        expect(caramelCouponAnchors('#promo-toggle')).toHaveLength(1)
    })

    it('still allows a config listing a few alternatives', () => {
        // Real configs sit at 1-3 visible matches, and themes legitimately
        // render a mobile and a desktop copy of the same control.
        doc.body.innerHTML = manyButtons(3)
        expect(caramelCouponAnchors('button')).toHaveLength(3)
    })

    it('rejects a selector matching more elements than a promo box could be', () => {
        doc.body.innerHTML = manyButtons(60)
        expect(caramelCouponAnchors('button')).toEqual([])
    })

    it('rejects at the mejuri scale that prompted this guard', () => {
        doc.body.innerHTML = manyButtons(389)
        expect(caramelCouponAnchors('button')).toEqual([])
    })

    it('treats an empty or missing selector as no match, not as breakage', () => {
        expect(caramelCouponAnchors('')).toEqual([])
        expect(caramelCouponAnchors(null)).toEqual([])
        expect(caramelCouponAnchors(undefined)).toEqual([])
    })

    it('counts only VISIBLE matches, so hidden bulk markup does not trip it', () => {
        // A theme can ship hundreds of hidden template nodes; those were never
        // a detection risk and must not become one now.
        doc.body.innerHTML =
            `<div style="display:none">${manyButtons(200)}</div>` +
            '<button id="real">Apply Promo Code</button>'
        const anchors = caramelCouponAnchors('button')
        expect(anchors).toHaveLength(1)
        expect(anchors[0].id).toBe('real')
    })
})
