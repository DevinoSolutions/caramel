import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// Characterization pins (F-004) — lock behavior of two pure/near-pure
// helpers that used to live in shared-utils.js (the repo's former #1-churn,
// #1-LOC file). F-008 split that file along its section banners into 6
// cohesive files, source order preserved, behavior unchanged (proven by a
// cat-diff of the 6 files against the pre-split file — see PLAN-F-008.md);
// getPrice/_isXPath now live in dom-utils.js. These pins were written
// BEFORE the split and passed unchanged AFTER it — that is the proof this
// characterization was meant to provide.
// Loaded ONCE for the whole file: the source has top-level guards against
// double-loading (window.__caramel_shared_utils_loaded, still that literal
// name post-split — it's a "move only" cut, no renames inside the moved
// code — now defined in caramel-base.js) so re-evaluating per-test would
// silently no-op the second time.
let _isXPath
let getPrice

beforeAll(() => {
    // F-006 — coupon-constants.generated.js sets window.CaramelCoupons,
    // which coupon-fetch.js (post-F-008) reads unconditionally at
    // module-eval time (RESTRICTED_STATUSES's rebind). Real load order
    // (manifest.json, manifest-firefox.json, index.html) always puts it
    // first; mirror that here or the content-script files throw on load.
    loadExtensionSource('coupon-constants.generated.js', [])
    // Load the 6 F-008 split files in real manifest load order, sharing ONE
    // chrome stub across all of them (loadExtensionSources, not 6 separate
    // loadExtensionSource calls) — matching how a real content-script realm
    // shares one `chrome` global across every file in the list.
    ;({ getPrice, _isXPath } = loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['getPrice', '_isXPath'],
    ))
})

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
