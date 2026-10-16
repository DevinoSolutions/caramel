import { describe, expect, it } from 'vitest'

import { isLearnedBoxSelector } from '@/lib/couponBoxSelector'

// The learned coupon box selector grammar (src/lib/couponBoxSelector.ts), the
// contract the extension emits against: what it must accept, and what a
// crowd-sourced report may never smuggle in.

describe('learned coupon box selector grammar', () => {
    it.each([
        '#promo',
        '.promo-code',
        'input',
        '*',
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
        'label + input',
        'h2 ~ div > button',
        'form .row > div input',
        'li:first-child > input',
        'li:nth-of-type(2) input',
        'tr:nth-child(12) button',
        'input:not([type="hidden"])',
        'button:not(.disabled)',
        'button:last-of-type',
        '.-x-promo',
        '#_code',
        'input[name=""]',
    ])('accepts %s', selector => {
        expect(isLearnedBoxSelector(selector)).toBe(true)
    })

    it.each([
        ['empty', ''],
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
        expect(isLearnedBoxSelector(selector)).toBe(false)
    })
})
