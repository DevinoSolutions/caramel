import { beforeEach, describe, expect, it } from 'vitest'
import {
    CARAMEL_OUTLINE_MAX_BYTES,
    caramelPageOutline,
} from '../coupon-box-outline.js'

// The outline the coupon-box pick reads. Its format is the one the server's
// pick was measured on, so these pin it to the character: roles, quoting,
// indentation, states, and what never leaves the page (free text, digits,
// email addresses).

const CART =
    '<header><nav aria-label="Main menu"><a href="/">Home</a>' +
    '<a href="/cart"><img alt="Cart 3 items"></a><a>Not a link</a></nav></header>' +
    '<main>' +
    '<h1>Your cart (3 items)</h1>' +
    '<p>Order 12345 for jane.doe@example.com, ships to 10 Main St</p>' +
    '<section aria-label="Order summary"><table><tr><td>Widget</td><td>$12.99</td></tr></table></section>' +
    '<form>' +
    '<label for="email">Email</label><input id="email" type="email" value="jane.doe@example.com">' +
    '<input type="number" aria-label="Qty 2" value="2">' +
    '<button type="button" aria-expanded="false">Have a promo code?</button>' +
    '<div id="panel" style="display:none"><input id="pc" type="text"><button>Hidden apply</button></div>' +
    '<label>Gift card <input type="text" name="gc"></label>' +
    '<input type="text" placeholder="Promo code">' +
    '<input type="hidden" name="token" value="abc123">' +
    '<input type="submit" value="Apply 10% off">' +
    '<button disabled>Pay $87.01</button>' +
    '<div role="button" aria-disabled="true" aria-expanded="true">Details <span role="link">more</span></div>' +
    '</form>' +
    '<details><summary>Shipping (2)</summary><a href="/s">Rates</a></details>' +
    '<aside><dialog open><button aria-label="Close dialog 1"></button></dialog></aside>' +
    '</main>' +
    '<footer><fieldset><input type="search" title="Search 2026 deals"></fieldset></footer>' +
    '<script>var x = 1</script><svg><a href="/i">icon</a></svg>'

const EXPECTED = [
    '- banner:',
    '  - navigation "Main menu":',
    '    - [0] link "Home"',
    '    - [1] link "Cart # items"',
    '- main:',
    '  - heading "Your cart (# items)"',
    '  - region "Order summary":',
    '    - table:',
    '      - row:',
    '  - form:',
    '    - [2] textbox "Email"',
    '    - [3] spinbutton "Qty #"',
    '    - [4] button "Have a promo code?" [collapsed]',
    '    - [5] textbox "Gift card"',
    '    - [6] textbox "Promo code"',
    '    - [7] button "Apply ##% off"',
    '    - [8] button "Pay $##.##" [disabled]',
    '    - [9] button "Details more" [disabled, expanded]',
    '      - [10] link "more"',
    '  - group:',
    '    - [11] button "Shipping (#)"',
    '    - [12] link "Rates"',
    '  - complementary:',
    '    - dialog:',
    '      - [13] button "Close dialog #"',
    '- contentinfo:',
    '  - group:',
    '    - [14] searchbox "Search #### deals"',
].join('\n')

beforeEach(() => {
    document.body.innerHTML = ''
})

describe('the page outline', () => {
    it('is the measured format, to the character', () => {
        document.body.innerHTML = CART

        expect(caramelPageOutline(document.body).outline).toBe(EXPECTED)
    })

    it('maps every index back to the element it names, counting from 0', () => {
        document.body.innerHTML = CART

        const { elements } = caramelPageOutline(document.body)

        expect(elements).toHaveLength(15)
        expect(elements[6].getAttribute('placeholder')).toBe('Promo code')
        expect(elements[4].textContent).toBe('Have a promo code?')
        expect(elements[14].type).toBe('search')
    })

    it('carries no digit and no email address from the page, and no page text', () => {
        document.body.innerHTML = CART

        const { outline } = caramelPageOutline(document.body)
        // Every digit left is an index at the head of its line.
        const unindexed = outline.replace(/^(\s*- )\[\d+\] /gm, '$1')

        expect(unindexed).not.toMatch(/\d/)
        expect(outline).not.toMatch(/@|jane|example\.com/i)
        for (const text of ['Widget', 'ships to', 'Main St', 'abc', 'icon'])
            expect(outline).not.toContain(text)
    })

    it('never goes over the cap, and drops whole lines from the end', () => {
        // The cap is in UTF-8 bytes: each € heading line is ~300 bytes for
        // ~100 characters.
        const euros = '€'.repeat(99)
        document.body.innerHTML = Array.from(
            { length: 200 },
            () => `<h2>${euros}</h2><a href="/p">Item</a>`,
        ).join('')

        const { outline, elements } = caramelPageOutline(document.body)
        const lines = outline.split('\n')
        const indexed = lines.filter(l => /^- \[\d+\] /.test(l))
        const last = Number(/\[(\d+)\]/.exec(indexed.at(-1))[1])

        expect(new TextEncoder().encode(outline).length).toBeLessThanOrEqual(
            CARAMEL_OUTLINE_MAX_BYTES,
        )
        expect(lines.length).toBeLessThan(400)
        for (const line of lines)
            expect(line).toMatch(/^- (heading "€{99}"|\[\d+\] link "Item")$/)
        // An index cut off with its line is never mapped back.
        expect(elements).toHaveLength(last + 1)
    })
})
