import { beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// The DOM apply path used to bank EVERY win as 'USD'. The modal renders the
// symbol the price parser actually saw (getPrice records £/€/$), so a British
// user was shown "£8.00" and then had 8 added to a dollar total — and the
// popup sums the history PER CURRENCY through Intl.NumberFormat
// (popup.js:81-98), so the mislabelled rows landed in the wrong bucket and
// overstated the lifetime figure for anyone outside the US.
//
// caramelCurrencyCode() is the bridge: symbol seen on the page -> ISO code
// stored in the history.
let getPrice
let caramelCurrencyCode

beforeEach(() => {
    ;({ getPrice, caramelCurrencyCode } = loadExtensionSources(
        ['caramel-base.js', 'dom-utils.js'],
        ['getPrice', 'caramelCurrencyCode'],
    ))
    document.body.innerHTML = ''
    // dom-utils declares _caramelLastCurrency with the guarded-`var` pattern,
    // so re-loading the source deliberately does NOT reset it (re-injection
    // safety). Clear it here so each case starts like a fresh page.
    globalThis._caramelLastCurrency = '$'
})

/** jsdom computes no layout, so innerText is undefined; getPrice reads it. */
const readTotal = text => {
    const el = document.createElement('div')
    el.id = 'total'
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
    document.body.appendChild(el)
    return getPrice('#total', { returnLargest: true })
}

describe('savings history currency', () => {
    it('banks a sterling cart as GBP, not dollars', () => {
        expect(readTotal('£108.00')).toBe(108)
        expect(caramelCurrencyCode()).toBe('GBP')
    })

    it('banks a euro cart as EUR', () => {
        expect(readTotal('€96.50')).toBe(96.5)
        expect(caramelCurrencyCode()).toBe('EUR')
    })

    it('banks a dollar cart as USD', () => {
        expect(readTotal('$120.00')).toBe(120)
        expect(caramelCurrencyCode()).toBe('USD')
    })

    it('follows the price it actually returned when a container mixes symbols', () => {
        // The largest number wins the total read, and the code must describe
        // THAT price — not whichever symbol happened to appear first.
        expect(readTotal('was $9.00 · now £150.00')).toBe(150)
        expect(caramelCurrencyCode()).toBe('GBP')
    })

    it('defaults to USD before any price has been read', () => {
        expect(caramelCurrencyCode()).toBe('USD')
    })
})
