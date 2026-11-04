import { beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelDisclosureFor, caramelSubmitBesideInput } from '../dom-utils.js'
import { getDomainRecord, isCheckout } from '../store-detect.js'

// "Is the promo box visible?" conflates two different pages: one where the
// coupon markup is inert theme debris, and one where the box sits behind a
// disclosure the shopper opens in a single tap. Only the first deserves
// silence.
//
// Measured on 2026-08-05, both with the field present in the DOM and invisible:
//   allbirds.com on a phone — Shopify collapses the order summary, and the
//   discount field lives inside it. 30s on the cart drawer and 30s at checkout
//   gave nothing; expanding the summary produced the prompt within the same
//   second. A/B/A across three reloads confirmed it (1440 shows, 390 doesn't,
//   1440 shows), and 900/700/500 were silent too.
//   allposters.com at 1440 — promo box behind "+ Add a Promo Code". Same
//   signature on a different platform and a full-size window.
//
// This is the majority-traffic surface, so it is worth being precise about the
// narrowness of the rule: the control must govern an ANCESTOR of the coupon
// input the CONFIG names, be visible, not already be expanded, and pass the
// order-button guard. Anything else returns null and nothing changes.

// Seeded into getDomainRecord's own cache rather than stubbed in front of it,
// so the record has to name the host this realm is actually on — nothing below
// reads the domain itself.
const REC = { domain: location.hostname, couponInput: '#promo' }

// Replaced where isCheckout reads them: module imports now, not globals.
// probeCartJson isolates these cases from the cart gate; waitForElement is the
// no-op the suite always wanted (the box under test is present, just hidden).
vi.mock('../coupon-apply.js', async importOriginal =>
    passThrough(await importOriginal(), { probeCartJson: async () => null }),
)
// Spreading a module namespace SNAPSHOTS it, so any export the module
// REASSIGNS freezes at its initial value for everyone importing through the
// mock — measured here: the price set dom-utils republishes on each read
// stayed [] instead of [9,150]. Forward every untouched export as a getter
// so live bindings stay live, whichever ones those turn out to be.
function passThrough(actual, overrides) {
    const forwarded = Object.keys(actual)
        .filter(name => !(name in overrides))
        .map(name => [
            name,
            { get: () => actual[name], enumerable: true, configurable: true },
        ])
    return Object.defineProperties(
        { ...overrides },
        Object.fromEntries(forwarded),
    )
}

vi.mock('../dom-utils.js', async importOriginal =>
    passThrough(await importOriginal(), { waitForElement: async () => {} }),
)

/** jsdom has no layout, so checkVisibility() must be taught display:none. */
function stubVisibility() {
    Element.prototype.checkVisibility = function () {
        let node = this
        while (node && node.style) {
            if (node.style.display === 'none' || node.hidden) return false
            node = node.parentElement
        }
        return true
    }
}

beforeEach(() => {
    stubVisibility()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/checkout')
    getDomainRecord.cache = [REC]
})

/** The Shopify-phone shape: a toggle naming the collapsed section. */
function ariaDisclosure({ expanded = 'false', label = 'Order summary' } = {}) {
    document.body.innerHTML = `
        <button id="toggle" aria-controls="summary" aria-expanded="${expanded}">${label}</button>
        <div id="summary" style="display:none">
            <input id="promo" name="reductions" />
        </div>`
    return document.getElementById('toggle')
}

describe('caramelDisclosureFor', () => {
    it('finds the toggle that owns the collapsed section', () => {
        const toggle = ariaDisclosure()

        expect(caramelDisclosureFor(document.getElementById('promo'))).toBe(
            toggle,
        )
    })

    it('finds a native <details> summary', () => {
        // The AllPosters "+ Add a Promo Code" shape.
        document.body.innerHTML = `
            <details>
                <summary>Add a Promo Code</summary>
                <div style="display:none"><input id="promo" /></div>
            </details>`

        expect(
            caramelDisclosureFor(document.getElementById('promo')).tagName,
        ).toBe('SUMMARY')
    })

    it('leaves a box the shopper can already see alone', () => {
        ariaDisclosure()
        document.getElementById('summary').style.display = ''

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('does not treat an already-open section as something to click', () => {
        ariaDisclosure({ expanded: 'true' })

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('refuses a toggle that is really the order button', () => {
        // The guard that matters most: a page whose disclosure control is
        // labelled "Place order" must never be clicked to reveal a promo box.
        ariaDisclosure({ label: 'Place order' })

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('ignores a control that governs something else entirely', () => {
        document.body.innerHTML = `
            <button id="toggle" aria-controls="shipping" aria-expanded="false">Shipping</button>
            <div id="shipping"></div>
            <div id="wrap" style="display:none"><input id="promo" /></div>`

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('gives up rather than climb the whole page', () => {
        // A toggle eight levels above the input is not describing this box.
        const deep = Array.from({ length: 8 }, () => '<div>').join('')
        document.body.innerHTML = `
            <button id="toggle" aria-controls="far" aria-expanded="false">Open</button>
            <div id="far" style="display:none">${deep}<input id="promo" /></div>`

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('handles a missing or unmatched box without throwing', () => {
        expect(caramelDisclosureFor(null)).toBeNull()
    })
})

/** lindtusa.com's cart (2026-10-27), trimmed to its structure: Magento's
 * collapsible widget wraps the whole discount block, so the closed panel is
 * the input's seventh ancestor and its header carries no aria-controls. The
 * config names `#block-discount-heading, .block.discount .title` as the
 * toggle, and neither exists. */
function magentoCollapsible({ expanded = 'false', header = 'title' } = {}) {
    const headerAttrs =
        header === 'title'
            ? `data-role="title" role="tab" aria-expanded="${expanded}"`
            : 'class="summary"'
    document.body.innerHTML = `
        <div class="block" data-collapsible="true" role="tablist">
            <div id="opener" class="title" ${headerAttrs} tabindex="0"><strong>Enter Promotion Code</strong></div>
            <div class="content" data-role="content" role="tabpanel" style="display:none">
                <div id="block-discount" class="block discount">
                    <div class="content" data-role="content">
                        <form id="discount-coupon-form">
                            <div class="fieldset amcoupons-main-container">
                                <div class="field amcoupons-input"><div class="control">
                                    <input id="promo" class="input-text" type="text" name="discount_code" />
                                </div></div>
                                <div class="actions-toolbar">
                                    <button class="amcoupons-apply action primary" type="submit">Apply</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>`
    return document.getElementById('opener')
}

describe("caramelDisclosureFor — Magento's collapsible widget", () => {
    it('finds the header of the closed panel the box sits in', () => {
        const opener = magentoCollapsible()

        expect(caramelDisclosureFor(document.getElementById('promo'))).toBe(
            opener,
        )
    })

    it('does not click a header that says its panel is open', () => {
        magentoCollapsible({ expanded: 'true' })

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })

    it('takes only the header the widget marks, not whatever comes before', () => {
        magentoCollapsible({ header: 'none' })

        expect(
            caramelDisclosureFor(document.getElementById('promo')),
        ).toBeNull()
    })
})

describe('isCheckout — a config whose toggle no longer matches', () => {
    it("offers help when the box's own panel header can open it", async () => {
        getDomainRecord.cache = [
            {
                ...REC,
                couponInput: '#promo',
                showInput: '#block-discount-heading, .block.discount .title',
            },
        ]
        magentoCollapsible()

        expect(await isCheckout()).toBe(true)
    })
})

describe('caramelSubmitBesideInput', () => {
    const promo = () => document.getElementById('promo')

    it("finds the one button of the box's own form", () => {
        document.body.innerHTML = `
            <form><input id="promo" /><button id="go" type="submit">Apply</button></form>`

        expect(caramelSubmitBesideInput(promo()).id).toBe('go')
    })

    it('does not guess in a form with a choice of buttons', () => {
        document.body.innerHTML = `
            <form><input id="promo" />
                <button type="submit">Apply</button>
                <button type="submit">Remove</button></form>`

        expect(caramelSubmitBesideInput(promo())).toBeNull()
    })

    it('leaves a form that asks for more than the code', () => {
        // The coupon field inside a larger form (an address, an email): its
        // one submit button sends that whole form, not the code.
        document.body.innerHTML = `
            <form><input id="email" type="email" /><input id="promo" />
                <button type="submit">Continue</button></form>`

        expect(caramelSubmitBesideInput(promo())).toBeNull()
    })

    it('needs a form to look in', () => {
        document.body.innerHTML = '<input id="promo" /><button>Apply</button>'

        expect(caramelSubmitBesideInput(promo())).toBeNull()
        expect(caramelSubmitBesideInput(null)).toBeNull()
    })

    it('ignores a hidden button', () => {
        document.body.innerHTML = `
            <form><input id="promo" />
                <button type="submit">Apply</button>
                <button type="submit" style="display:none">Remove</button></form>`

        expect(caramelSubmitBesideInput(promo()).textContent).toBe('Apply')
    })
})

describe('isCheckout — a closed drawer is not a dead page', () => {
    it('offers help where the promo box is one tap away', async () => {
        ariaDisclosure()

        expect(await isCheckout()).toBe(true)
    })

    it('still stays quiet on a page whose coupon markup is inert', async () => {
        // Guards the guard: hidden with NO way to open it is the case the
        // visibility rule exists for, and it must keep working.
        document.body.innerHTML =
            '<div style="display:none"><input id="promo" /></div>'

        expect(await isCheckout()).toBe(false)
    })

    it('still works the ordinary way when the box is plainly visible', async () => {
        document.body.innerHTML = '<input id="promo" />'

        expect(await isCheckout()).toBe(true)
    })
})
