import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    caramelBoxSelectors,
    caramelLearnedOutcome,
    caramelOne,
    caramelSelectorAllowed,
    caramelStableSelector,
    LEARNED_KEY,
    MAX_DOMAINS,
} from '../coupon-box-learned.js'

// The learned-box memory (coupon-box-learned.js): the selectors a confirmed
// box is saved under, and the per-install memory of those boxes. These pin:
//   · a selector is built only from names a store keeps between renders, and
//     only when it finds exactly the element it names;
//   · nothing the shopper or the cart wrote (an email, a number, a price) is
//     ever part of one;
//   · two failed uses forget a box, a confirmed use resets it, and the memory
//     keeps the 200 most recently used domains.

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

// The grammar a learned box's selectors are built and read in: a served or
// stored selector is data, and only this small, cheap subset of CSS is ever
// queried.
describe('the learned-box selector grammar', () => {
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
        // Outside the grammar the server accepts: never built, so a report
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
            enterOnly: false,
        })
    })

    it('a box with no button applies on Enter', () => {
        page('<input name="coupon">')
        expect(caramelBoxSelectors($('input'), null, null)).toEqual({
            input: 'input[name="coupon"]',
            apply: null,
            toggle: null,
            enterOnly: true,
        })
    })

    it('half a box is not a box: a part with no stable name names nothing', () => {
        page(
            '<input name="coupon"><button>Apply</button><button>Apply</button>',
        )
        expect(caramelBoxSelectors($('input'), $('button'), null)).toBeNull()
    })
})

describe('caramelLearnedOutcome', () => {
    let data
    const area = {
        get: (keys, cb) => cb({ [LEARNED_KEY]: data }),
        set: (items, cb) => {
            data = structuredClone(items[LEARNED_KEY])
            cb()
        },
    }
    const BOX = {
        input: 'input[name="coupon"]',
        apply: 'button#apply',
        toggle: null,
        enterOnly: false,
    }
    const OTHER = { ...BOX, input: 'input[name="gift"]' }
    const learn = (outcome, box = BOX, domain = 'shop.test', now = 1) =>
        caramelLearnedOutcome(area, domain, box, 'rules', outcome, now)

    beforeEach(() => {
        data = undefined
    })

    it('a confirmed box is saved with no failures', async () => {
        expect(await learn('confirmed')).toBe('saved')
        expect(data['shop.test']).toEqual({
            v: 1,
            ...BOX,
            source: 'rules',
            confirmedAt: 1,
            failures: 0,
        })
    })

    it('two failed uses forget it; a confirmed use in between resets the count', async () => {
        await learn('confirmed')
        expect(await learn('failed')).toBe('failed')
        expect(data['shop.test'].failures).toBe(1)
        await learn('confirmed')
        expect(data['shop.test'].failures).toBe(0)
        await learn('failed')
        expect(await learn('failed')).toBe('dropped')
        expect(data['shop.test']).toBeUndefined()
    })

    it('a failure of some other box leaves the saved one as it was', async () => {
        await learn('confirmed')
        expect(await learn('failed', OTHER)).toBe('kept')
        expect(data['shop.test']).toMatchObject({ ...BOX, failures: 0 })
    })

    it('keeps the 200 most recently used domains', async () => {
        for (let i = 0; i < MAX_DOMAINS + 5; i++)
            await learn('confirmed', BOX, `s${i}.test`, i)
        const keys = Object.keys(data)
        expect(keys).toHaveLength(MAX_DOMAINS)
        expect(keys[0]).toBe('s5.test')
        // A confirmed use makes a domain the most recent again.
        await learn('confirmed', BOX, 's5.test', 999)
        await learn('confirmed', BOX, 'new.test', 1000)
        expect(Object.keys(data)).toContain('s5.test')
        expect(Object.keys(data)).not.toContain('s6.test')
    })

    it('a storage refusal is thrown, so the caller can say so', async () => {
        const refusing = {
            get: (_k, cb) => {
                globalThis.chrome = {
                    runtime: { lastError: { message: 'QUOTA' } },
                }
                cb({})
            },
            set: () => {},
        }
        try {
            await expect(
                caramelLearnedOutcome(
                    refusing,
                    'shop.test',
                    BOX,
                    'rules',
                    'confirmed',
                    1,
                ),
            ).rejects.toThrow('QUOTA')
        } finally {
            delete globalThis.chrome
        }
    })
})
