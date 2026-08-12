import { describe, expect, it } from 'vitest'
import {
    caramelCurrencyCode,
    caramelFindMoney,
    caramelParseMoneyNumber,
    getPrice,
} from '../dom-utils.js'

// The price reader required $ £ or € IMMEDIATELY BEFORE the digits, then parsed
// by stripping everything except [0-9.]. That reads the United States and the
// UK, and nowhere else — and the saving is the product's whole headline.
//
// Measured against live storefronts during the QA sweep (2026-08-05/06):
//   motoin.de      "Zwischensumme: 565.89 ت"  → "getPrice: no price found" on a
//                                               real basket
//   mango.com/ae   "AED 949.00"               → unreadable
//   rag-bone.com   "DT 445.00" → "DT 356.00"  → a genuine 20% discount applied,
//                                               and the shopper was never told
//                                               the number
//   rosegal.com    "3,49 €"                   → unreadable
//   German         "1.234,56 €"               → MIS-PARSED to 1.234 by the old
//                                               strip: a 1000x understatement
//
// Two rules hold the whole thing together. A currency marker is still REQUIRED,
// so a bare number from "Qty 2" is never money. And letter codes must be
// uppercase (or one of a few named lowercase ones), which is what stops "Save
// 10" and "Total 5" parsing as prices.

/** getPrice reads innerText, which jsdom leaves undefined. */
function priceFrom(text, options) {
    document.body.innerHTML = '<div id="total"></div>'
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
    return getPrice('#total', options)
}

const first = text => caramelFindMoney(text)[0]

describe('the number, whichever way the world writes it', () => {
    it('reads a plain decimal', () => {
        expect(caramelParseMoneyNumber('356.00')).toBe(356)
        expect(caramelParseMoneyNumber('89,99')).toBe(89.99)
    })

    it('reads either thousands convention', () => {
        expect(caramelParseMoneyNumber('1,234.56')).toBe(1234.56)
        expect(caramelParseMoneyNumber('1.234,56')).toBe(1234.56)
        expect(caramelParseMoneyNumber('1 299,00')).toBe(1299)
    })

    it('does not turn a German thousands separator into a decimal point', () => {
        // The old parser returned 1.234 here — off by a factor of a thousand,
        // in the direction of understating what the shopper saved.
        expect(caramelParseMoneyNumber('1.234')).toBe(1234)
        expect(caramelParseMoneyNumber('1,234')).toBe(1234)
    })
})

describe('the currencies real storefronts actually price in', () => {
    const cases = [
        ['Total $1,234.56', 1234.56, '$'],
        ['Total £89.99', 89.99, '£'],
        ['Total €89.99', 89.99, '€'],
        ['Zwischensumme: 1.234,56 €', 1234.56, '€'],
        ['Total : 89,99 €', 89.99, '€'],
        ['Totale 89,99 €', 89.99, '€'],
        ['Totalt 1 299,00 kr', 1299, 'kr'],
        ['Razem 199,99 zł', 199.99, 'zł'],
        ['Total CHF 89.90', 89.9, 'CHF'],
        ['AED 949.00', 949, 'AED'],
        ['DT 445.00', 445, 'DT'],
        ['Zwischensumme: 565.89 ت', 565.89, 'ت'],
        ['合計 ¥1,280', 1280, '¥'],
        ['Total ₹2,499.00', 2499, '₹'],
        ['Total CA$129.99', 129.99, 'CA$'],
    ]

    for (const [text, value, marker] of cases) {
        it(`reads ${JSON.stringify(text)}`, () => {
            const hit = first(text)
            expect(hit, text).toBeTruthy()
            expect(hit.value, text).toBeCloseTo(value, 2)
            expect(hit.marker, text).toBe(marker)
        })
    }
})

describe('a number is not money just because it is a number', () => {
    it('ignores quantities, sizes and counts', () => {
        expect(caramelFindMoney('Qty 2')).toEqual([])
        expect(caramelFindMoney('Size 10')).toEqual([])
        expect(caramelFindMoney('2 items')).toEqual([])
        expect(caramelFindMoney('Bag subtotal 4 items')).toEqual([])
    })

    it('does not read an ordinary word as a currency code', () => {
        // The reason letter markers must be uppercase.
        expect(caramelFindMoney('Save 10')).toEqual([])
        expect(caramelFindMoney('Total 5')).toEqual([])
    })

    it('does not read a percentage or an order number as an amount', () => {
        expect(caramelFindMoney('20% off your order')).toEqual([])
        expect(caramelFindMoney('Order #12345')).toEqual([])
        expect(caramelFindMoney('Order Total 28.00')).toEqual([]) // no marker
    })

    it('reads the amount when a total names its currency twice', () => {
        // "Total USD $70.50" — the shape Shopify checkouts print.
        const hit = first('Total USD $70.50')
        expect(hit.value).toBeCloseTo(70.5, 2)
    })

    it('handles empty and absent text', () => {
        expect(caramelFindMoney('')).toEqual([])
        expect(caramelFindMoney(null)).toEqual([])
    })
})

describe('getPrice on a real order summary', () => {
    it('reads the order total on a German cart', () => {
        expect(
            priceFrom('Zwischensumme 1.234,56 € Gesamt 1.334,56 €', {
                returnLargest: true,
            }),
        ).toBeCloseTo(1334.56, 2)
    })

    it('reads the rag-bone total that used to be invisible to us', () => {
        expect(
            priceFrom('DT 445.00 DT 356.00', { returnLargest: true }),
        ).toBeCloseTo(445, 2)
    })

    it('still reads a plain dollar cart exactly as before', () => {
        expect(
            priceFrom('Shipping $0.00 Order Total $28.00', {
                returnLargest: true,
            }),
        ).toBeCloseTo(28, 2)
    })

    it('banks a non-dollar saving under its own currency, not USD', () => {
        priceFrom('AED 949.00', { returnLargest: true })
        expect(caramelCurrencyCode()).toBe('AED')

        priceFrom('Total £89.99', { returnLargest: true })
        expect(caramelCurrencyCode()).toBe('GBP')

        priceFrom('Total $28.00', { returnLargest: true })
        expect(caramelCurrencyCode()).toBe('USD')
    })
})
