import { beforeEach, describe, expect, it } from 'vitest'
import { _isXPath, getPrice } from '../dom-utils.js'

// Characterization pins (F-004) — lock behavior of two pure/near-pure
// helpers that used to live in shared-utils.js (the repo's former #1-churn,
// #1-LOC file). F-008 split that file along its section banners into 6
// cohesive files, source order preserved, behavior unchanged (proven by a
// cat-diff of the 6 files against the pre-split file — see PLAN-F-008.md);
// getPrice/_isXPath now live in dom-utils.js. These pins were written
// BEFORE the split and passed unchanged AFTER it — that is the proof this
// characterization was meant to provide.
// Both helpers are imported straight from the file F-008 moved them into.
// The manifest load order the old harness had to replay by hand (constants
// first, then the six split files) is now the module graph's job — importing
// dom-utils.js pulls in exactly what it depends on, in dependency order.
beforeEach(() => {
    document.body.innerHTML = ''
})

describe('_isXPath (dom-utils.js:153, pure)', () => {
    it('recognizes XPath expressions by leading token', () => {
        expect(_isXPath('//input')).toBe(true)
        expect(_isXPath('(//div)[2]')).toBe(true)
        expect(_isXPath('./x')).toBe(true)
    })

    it('rejects CSS selectors, empty strings, and non-strings', () => {
        expect(_isXPath('input#code')).toBe(false)
        expect(_isXPath('')).toBe(false)
        expect(_isXPath(null)).toBe(false)
        expect(_isXPath(undefined)).toBe(false)
        expect(_isXPath(42)).toBe(false)
    })
})

describe('getPrice (dom-utils.js:123)', () => {
    // getPrice reads el.innerText, which jsdom does not compute from
    // textContent/layout — set BOTH explicitly. Object.defineProperty
    // guarantees the assignment sticks even if jsdom ever defines
    // innerText as a getter-only accessor.
    function makeEl(text) {
        const el = document.createElement('div')
        el.id = 'price'
        el.textContent = text
        Object.defineProperty(el, 'innerText', {
            value: text,
            configurable: true,
        })
        document.body.appendChild(el)
        return el
    }

    it('parses a single price', () => {
        makeEl('$100.00')
        expect(getPrice('#price')).toBe(100)
    })

    it('defaults to the first match when multiple prices are present', () => {
        makeEl('Now $75.00 (was $100.00)')
        expect(getPrice('#price')).toBe(75)
    })

    it('returns the largest match when { returnLargest: true }', () => {
        makeEl('Now $75.00 (was $100.00)')
        expect(getPrice('#price', { returnLargest: true })).toBe(100)
    })

    it('returns NaN when the element has no price-shaped text', () => {
        makeEl('Free shipping')
        expect(getPrice('#price')).toBeNaN()
    })

    it('returns NaN when the selector matches nothing', () => {
        expect(getPrice('#does-not-exist')).toBeNaN()
    })
})
