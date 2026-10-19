import { beforeEach, describe, expect, it } from 'vitest'
import {
    ALLOWED_WORDS,
    CARAMEL_OUTLINE_MAX_BYTES,
    caramelAllowedWords,
    caramelPageOutline,
} from '../coupon-box-outline.js'

// The outline the coupon-box pick reads. Its format is the one the server's
// pick was measured on, so these pin it to the character: roles, quoting,
// indentation, states, and what never leaves the page (free text, digits,
// email addresses, and every word not on the allowlist).

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
    // "Rates" is not an allowlisted word: the link keeps its role, not its name.
    '    - [12] link',
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

    // A digit in any script has no letters, so without a Unicode-aware scrub
    // the allowlist would keep a phone number written in it verbatim.
    it('carries no digit in any script', () => {
        document.body.innerHTML = [
            '<button>Deliver to ۰۹۱۲۳۴۵۶۷۸۹</button>',
            '<button>Deliver to ٠١٢٣٤٥٦٧٨٩</button>',
            '<button>Deliver to ０３１２３４５６７８</button>',
            '<button>Deliver to ①②③ 𝟏𝟐𝟑 Ⅷ</button>',
        ].join('')

        const { outline } = caramelPageOutline(document.body)
        const unindexed = outline.replace(/^(\s*- )\[\d+\] /gm, '$1')

        expect(unindexed).not.toMatch(/\p{N}/u)
        expect(outline).toContain('- [0] button "to ###########"')
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

// A checkout drawn for a signed-in shopper: every place a store prints the
// shopper's own details into an element's name. Placeholder details only.
const CHECKOUT =
    '<header><a href="/account">Signed in as Avery Sample</a></header>' +
    '<main>' +
    '<h1>Hello Avery, welcome back</h1>' +
    '<fieldset><legend>Saved addresses</legend>' +
    '<label><input type="radio" name="addr" checked> Avery Sample, 12 Testing Lane, Sampletown</label>' +
    '<input type="radio" name="addr" aria-label="Robin Sample, 9 Quill Road, Otherville">' +
    '</fieldset>' +
    '<button type="button">Deliver to Avery Sample</button>' +
    '<section aria-label="Avery Sample delivery"><p>Arrives soon</p></section>' +
    '<input type="text" role="button" value="Happy birthday Robin, love from Kit">' +
    '<form>' +
    '<label for="dc">Discount code or gift card</label><input id="dc" type="text">' +
    '<input type="submit" value="Apply">' +
    '</form>' +
    '</main>'

const PERSONAL = [
    'avery',
    'sample',
    'robin',
    'kit',
    'testing',
    'quill',
    'sampletown',
    'otherville',
    'happy',
    'birthday',
    'love',
    'hello',
    'welcome',
]

describe('no shopper detail leaves the browser', () => {
    it('drops every word that is not on the allowlist, wherever it is', () => {
        document.body.innerHTML = CHECKOUT

        const { outline } = caramelPageOutline(document.body)

        for (const word of PERSONAL)
            expect(outline.toLowerCase()).not.toContain(word)
        expect(outline).toBe(
            [
                '- banner:',
                '  - [0] link "in as"',
                '- main:',
                '  - heading "back"',
                '  - group:',
                '    - [1] radio "##"',
                '    - [2] radio "#"',
                '  - [3] button "to"',
                '  - region "delivery":',
                '  - [4] button',
                '  - form:',
                '    - [5] textbox "Discount code or gift card"',
                '    - [6] button "Apply"',
            ].join('\n'),
        )
    })

    it('reads no value but a button the store drew', () => {
        document.body.innerHTML =
            '<input type="text" role="button" value="Apply">' +
            '<input type="search" role="link" value="Apply">' +
            '<input type="submit" value="Apply">' +
            '<input type="button" value="Apply">' +
            '<input type="reset" value="Apply">'

        expect(caramelPageOutline(document.body).outline).toBe(
            [
                '- [0] button',
                '- [1] link',
                '- [2] button "Apply"',
                '- [3] button "Apply"',
                '- [4] button "Apply"',
            ].join('\n'),
        )
    })

    it('keeps the controls a store draws, verbatim but for digits', () => {
        const labels = [
            'Place order',
            'Buy now',
            'Delete',
            'Checkout',
            'Pay with PayPal',
            'Sign in',
            'Continue',
            'Pay $12.50 now',
        ]
        document.body.innerHTML = labels
            .map(l => `<button type="button">${l}</button>`)
            .join('')

        expect(caramelPageOutline(document.body).outline).toBe(
            labels
                .map((l, i) => `- [${i}] button "${l.replace(/\d/g, '#')}"`)
                .join('\n'),
        )
    })
})

describe('the word allowlist', () => {
    it('is the measured list', () => {
        expect(ALLOWED_WORDS.size).toBe(574)
        for (const w of ['buy', 'delete', 'place', 'voucher', 'zniżka'])
            expect(ALLOWED_WORDS.has(w)).toBe(true)
        for (const w of ALLOWED_WORDS) expect(w).toMatch(/^\p{Ll}+$/u)
    })

    it('keeps tokens of allowed words or no letters, verbatim, and drops the rest', () => {
        expect(caramelAllowedWords('Enter Promo-Code (Optional) *')).toBe(
            'Enter Promo-Code (Optional) *',
        )
        expect(caramelAllowedWords('Code: Avery-Sample # / ##')).toBe(
            'Code: # / ##',
        )
        expect(caramelAllowedWords('Avery Sample')).toBe('')
    })
})

// harryrosen.com draws its promo-code toggle as a plain <div> with a click
// handler and a pointer cursor: no role, no tag that means "button", so the
// outline carried no line for it and the pick had nothing to name. A short
// element the store itself made clickable now prints as a button.
describe('a control the store drew as plain text', () => {
    it('prints a short clickable element as a button the pick can name', () => {
        document.body.innerHTML =
            '<main><form>' +
            '<div id="toggle" style="cursor:pointer">Promo code</div>' +
            '<span onclick="x()">Have a promo code?</span>' +
            '<div tabindex="0">Apply</div>' +
            '<input type="text" placeholder="Promo code">' +
            '</form></main>'

        const { outline, elements } = caramelPageOutline(document.body)

        expect(outline).toBe(
            [
                '- main:',
                '  - form:',
                '    - [0] button "Promo code"',
                '    - [1] button "Have a promo code?"',
                '    - [2] button "Apply"',
                '    - [3] textbox "Promo code"',
            ].join('\n'),
        )
        expect(elements[0].id).toBe('toggle')
    })

    it('leaves text that nothing made clickable as it was', () => {
        document.body.innerHTML =
            '<main><div>Promo code</div><span>Apply</span>' +
            '<div tabindex="-1">Promo code</div></main>'

        expect(caramelPageOutline(document.body).outline).toBe('- main:')
    })

    it('reads a pointer cursor only where the element set it itself', () => {
        // The whole card is clickable; its short lines inherit the cursor
        // and are not controls of their own.
        document.body.innerHTML =
            '<div style="cursor:pointer">' +
            '<span style="cursor:pointer">Promo code</span>' +
            '<span>Apply</span>' +
            'and a long description of everything this card offers to you' +
            '</div>'

        expect(caramelPageOutline(document.body).outline).toBe('')
    })

    it('adds nothing inside a control the outline already names', () => {
        document.body.innerHTML =
            '<a href="/cart"><span onclick="x()">Cart</span> <button>Go</button></a>' +
            '<div role="dialog"><button><span onclick="x()">Apply</span></button></div>'

        expect(caramelPageOutline(document.body).outline).toBe(
            [
                '- [0] link "Cart Go"',
                '  - [1] button "Go"',
                '- dialog:',
                '  - [2] button "Apply"',
            ].join('\n'),
        )
    })

    it('keeps a clickable wrapper a wrapper, with its controls on their own lines', () => {
        document.body.innerHTML =
            '<div onclick="x()">Code <input type="text" aria-label="Promo code"></div>'

        expect(caramelPageOutline(document.body).outline).toBe(
            '- [0] textbox "Promo code"',
        )
    })

    it('skips long text, and text with no allowed word in it', () => {
        document.body.innerHTML =
            '<div onclick="x()">Use the code at checkout for a discount on items</div>' +
            '<div onclick="x()">Jane Doe</div>' +
            '<div onclick="x()">Edit 10 Downing St</div>'

        const { outline } = caramelPageOutline(document.body)

        expect(outline).toBe('- [0] button "Edit ##"')
        for (const word of ['jane', 'doe', 'downing'])
            expect(outline.toLowerCase()).not.toContain(word)
    })

    it('still prints one that carries an icon, which is not a control of its own', () => {
        document.body.innerHTML =
            '<main>' +
            '<div id="svg" tabindex="0">Promo code <svg role="img" aria-hidden="true"></svg></div>' +
            '<div id="pres" tabindex="0"><span role="presentation">+</span> Gift card</div>' +
            '</main>'

        const { outline, elements } = caramelPageOutline(document.body)

        expect(outline).toBe(
            [
                '- main:',
                '  - [0] button "Promo code"',
                '  - [1] button "+ Gift card"',
            ].join('\n'),
        )
        expect(elements.map(e => e.id)).toEqual(['svg', 'pres'])
    })

    it('leaves one holding an interactive role a wrapper', () => {
        document.body.innerHTML =
            '<main><div tabindex="0">Promo <span role="button">code</span></div></main>'

        expect(caramelPageOutline(document.body).outline).toBe(
            ['- main:', '  - [0] button "code"'].join('\n'),
        )
    })

    it('prints at most 30 of them on a page', () => {
        document.body.innerHTML = Array.from(
            { length: 40 },
            () => '<div onclick="x()">Apply</div>',
        ).join('')

        expect(caramelPageOutline(document.body).elements).toHaveLength(30)
    })
})

describe('an address is scrubbed at every length a name can have', () => {
    // The scrub is bounded at the lengths an address may have, as the
    // server's is. A name is clipped to 100 characters before it is scrubbed,
    // so a longer local part than the bound still leaves nothing behind.
    it('a plain address and one with a 100-character local part', () => {
        document.body.innerHTML =
            '<button type="button">Apply jane.doe@example.com</button>' +
            `<button type="button">Apply ${'x'.repeat(100)}@example.com</button>`

        const { outline } = caramelPageOutline(document.body)

        expect(outline).not.toMatch(/@|jane|example|xxx/i)
    })
})
