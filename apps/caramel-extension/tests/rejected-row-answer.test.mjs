import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A store that answers a code with a "NOT APPLIED" row and no error text.
 *
 * Live on aquasana.com (Salesforce Commerce Cloud, 1.4.23, 2026-10-27): a code
 * that exists but does not fit the cart is listed among the applied coupons
 * as "JULY50 NOT APPLIED ×" (.coupon-price-adjustment, the config's success
 * selector), and the error box stays empty. The row was refused as a success,
 * but nothing took it as the store's answer: errorMsg null, so two such codes
 * read as a silent checkout and the run stopped with eight codes untried
 * (T-9569).
 */

let applyCoupon

/** jsdom has no layout: innerText is set by hand (see apply-verdict.test). */
function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', {
        value: text,
        configurable: true,
    })
}

/** The store's answer: one more row in its applied-coupons list. */
function addRow(text) {
    const row = document.createElement('div')
    row.className = 'coupon-price-adjustment'
    setText(row, text)
    document.getElementById('coupons').appendChild(row)
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

const REC = {
    domain: 'example.com',
    couponInput: '#couponCode',
    couponSubmit: '#apply',
    priceContainer: '.grand-total',
    successIndicator: '.coupon-price-adjustment',
    errorIndicator: '#invalidCouponCode',
}

beforeEach(async () => {
    document.body.innerHTML = `
        <form class="promo-code-form">
            <input id="couponCode" />
            <button id="apply" type="button">Apply</button>
            <div id="invalidCouponCode" class="coupon-error-message"></div>
        </form>
        <div id="coupons"></div>
        <p class="grand-total"></p>`
    setText(document.querySelector('.grand-total'), '$80.48')
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
})

describe('a store that answers with a "not applied" row', () => {
    it('reads the row as its answer to this code', async () => {
        document
            .getElementById('apply')
            .addEventListener('click', () =>
                setTimeout(() => addRow('JULY50 NOT APPLIED ×'), 100),
            )

        const res = await applyCoupon('JULY50', REC)

        expect(res.success).toBe(false)
        expect(res.committed).toBe(false)
        expect(res.errorMsg).toMatch(/JULY50 NOT APPLIED/)
        // The runner counts the code as answered only on a new error.
        expect(res.errorIsNew).toBe(true)
        // ...and takes the refused code off before the next one.
        expect(res.answeredByRow).toBe(true)
    }, 15000)

    it('does not quote a row an earlier code left behind', async () => {
        addRow('OLDCODE NOT APPLIED ×')
        // This code: the store re-draws the list with the old row only.
        document.getElementById('apply').addEventListener('click', () =>
            setTimeout(() => {
                document.getElementById('coupons').innerHTML = ''
                addRow('OLDCODE NOT APPLIED ×')
            }, 100),
        )

        const res = await applyCoupon('JULY50', { ...REC })

        expect(res.errorMsg ?? '').not.toMatch(/OLDCODE/)
    }, 15000)

    it('still counts a row that applied as a success', async () => {
        document.getElementById('apply').addEventListener('click', () =>
            setTimeout(() => {
                addRow('SAVE10 -$8.05')
                setText(document.querySelector('.grand-total'), '$72.43')
            }, 100),
        )

        const res = await applyCoupon('SAVE10', REC)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(72.43)
        expect(res.answeredByRow).toBe(false)
    }, 15000)
})
