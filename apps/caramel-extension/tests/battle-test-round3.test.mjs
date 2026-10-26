import { describe, expect, it } from 'vitest'
import {
    caramelCurrencyCode,
    caramelFindMoney,
    getPrice,
} from '../dom-utils.js'

// Battle test, round 3 (T-8654): the amount itself. Every saving Caramel
// reports is the order total read before and after a code; an amount read
// as a thousandth of itself, or not at all, is a wrong (or silent) saving.
// Each case is written the way real stores in that market print a total.

const first = text => caramelFindMoney(text)[0]?.value

describe('amounts as stores print them', () => {
    it.each([
        // India: lakh grouping (1,23,456) on Flipkart, Myntra, Nykaa, Shopify IN.
        ['₹1,23,456.00', 123456],
        ['₹ 1,23,456', 123456],
        ['Rs. 12,34,567.50', 1234567.5],
        ['INR 2,49,999', 249999],
        ['₹45,999', 45999],
        // Japan: yen written as 円 after the amount, often with tax words.
        ['4,480円', 4480],
        ['12,800円（税込）', 12800],
        ['¥12,800', 12800],
        // Switzerland: whole francs written with a dash for the cents.
        ["CHF 1'249.–", 1249],
        ['CHF 89.–', 89],
        ['Fr. 49.90', 49.9],
        // Unicode minus and narrow no-break space grouping (French locale).
        ['1 234,56 €', 1234.56],
        ['−5,00 €', 5],
        // Brazil, Mexico, South Africa, Malaysia, Philippines, Poland.
        ['R$ 1.299,90', 1299.9],
        ['MX$1,299.00', 1299],
        ['R 1 299,00', 1299],
        ['RM 129.00', 129],
        ['₱1,299.00', 1299],
        ['1 299,99 zł', 1299.99],
        // Arabic and Gulf stores.
        ['214.00 د.إ', 214],
        ['د.إ 214.00', 214],
        ['199 ر.س', 199],
        // Label and amount in adjacent elements read as one word.
        ['TotalRs. 1,23,456', 123456],
        ['TotalS$ 129.00', 129],
        ['TotalR 1 299,00', 1299],
    ])('%s', (text, value) => {
        expect(first(text)).toBeCloseTo(value, 2)
    })
})

describe('text that is not an amount', () => {
    it.each([
        ['Qty 2'],
        ['Size 42'],
        ['Save 10%'],
        ['Order #10234'],
        ['2 items'],
    ])('%s reads as no money', text => {
        expect(caramelFindMoney(text)).toEqual([])
    })
})

/* ================================================ the savings history code */
// A measured saving is banked under the currency the total was read in. The
// account only takes ISO 4217 codes (three letters): a mark the page writes
// any other way used to be banked as USD (50 zł became $50 in the shopper's
// lifetime total) or sent as "DT" / "RM", which the account refuses.
function totalReads(text) {
    document.body.innerHTML = '<div id="total"></div>'
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
    return getPrice('#total', { returnLargest: true })
}

describe('the currency a saving is banked under', () => {
    it.each([
        ['199,99 zł', 'PLN'],
        ['1 379 Kč', 'CZK'],
        ['14 480 Ft', 'HUF'],
        ['265,98 lei', 'RON'],
        ['4 890 ₽', 'RUB'],
        ['1.299,80 TL', 'TRY'],
        ['₺1.299,80', 'TRY'],
        ['42,000원', 'KRW'],
        ['₩42,000', 'KRW'],
        ['309.00元', 'CNY'],
        ['4,480円', 'JPY'],
        ['₪229.80', 'ILS'],
        ['฿1,340.00', 'THB'],
        ['480.000₫', 'VND'],
        ['₱1,299.00', 'PHP'],
        ['1 369 ₴', 'UAH'],
        ['Rp 265.000', 'IDR'],
        ['Rs. 12,34,567.50', 'INR'],
        ['₹1,23,456.00', 'INR'],
        ['R$ 1.299,90', 'BRL'],
        ['R 1 299,00', 'ZAR'],
        ['Fr. 49.90', 'CHF'],
        ['DT 445.00', 'TND'],
        ['RM 129.00', 'MYR'],
        ['CA$129.00', 'CAD'],
        ['AU$129.00', 'AUD'],
        ['NT$1,350', 'TWD'],
        ['S$ 129.00', 'SGD'],
        ['A$129.00', 'AUD'],
        ['C$129.00', 'CAD'],
        ['MX$1,299.00', 'MXN'],
        ['214.00 د.إ', 'AED'],
        ['199 ر.س', 'SAR'],
        ['AED 949.00', 'AED'],
        ['£89.99', 'GBP'],
        ['$28.00', 'USD'],
    ])('%s -> %s', (text, code) => {
        expect(totalReads(text)).toBeGreaterThan(0)
        expect(caramelCurrencyCode()).toBe(code)
    })

    it('every code it returns is one the account accepts', () => {
        for (const text of ['899,00 kr', '12 990 kr.', 'XY 12.00', '₦12,500']) {
            totalReads(text)
            expect(caramelCurrencyCode()).toMatch(/^[A-Z]{3}$/)
        }
    })

    it.each([
        ['shop.se', 'SEK'],
        ['www.shop.no', 'NOK'],
        ['shop.dk', 'DKK'],
        ['shop.is', 'ISK'],
    ])('kronor on %s are %s', (host, code) => {
        const real = window.location
        Object.defineProperty(window, 'location', {
            value: new URL(`https://${host}/checkout`),
            configurable: true,
        })
        try {
            totalReads('899,00 kr')
            expect(caramelCurrencyCode()).toBe(code)
        } finally {
            Object.defineProperty(window, 'location', {
                value: real,
                configurable: true,
            })
        }
    })
})
