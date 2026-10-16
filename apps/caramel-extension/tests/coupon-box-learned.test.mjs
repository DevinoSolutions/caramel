import { beforeEach, describe, expect, it } from 'vitest'
import {
    caramelBoxSelectors,
    caramelLearnedOutcome,
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

    it('null when nothing names it within four steps: no fragile long path', () => {
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
