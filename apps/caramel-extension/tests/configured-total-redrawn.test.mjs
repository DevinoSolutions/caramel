import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A store with a configured total that answers by drawing a NEW total
 * element. Measured on a saved box at bumbleandbumble.com (2026-10-22): about
 * 2s after Apply the store removed `div.js-total-cost` and drew a new one
 * holding the discounted total. The apply flow watched the element it found
 * first, which never changed, so every code waited the full 10s window, the
 * one that worked included.
 */

let applyCoupon
let waitForTotalChange

/** jsdom has no layout: innerText is set by hand (see apply-verdict.test). */
function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', {
        value: text,
        configurable: true,
    })
}

/** The store's answer: the total element replaced by a new one. */
function redrawTotal(text) {
    document.getElementById('total').remove()
    const fresh = document.createElement('div')
    fresh.id = 'total'
    setText(fresh, text)
    document.body.appendChild(fresh)
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(async () => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<div id="total"></div>'
    setText(document.getElementById('total'), '$100.00')
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
    ;({ waitForTotalChange } = await import('../dom-utils.js'))
})

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

describe('a configured total the store draws anew', () => {
    it('a code that lowers a re-drawn total is read when the store answers, not after the whole window', async () => {
        document
            .getElementById('apply')
            .addEventListener('click', () =>
                setTimeout(() => redrawTotal('$85.00'), 150),
            )

        const startedAt = performance.now()
        const res = await applyCoupon('TEXT15', REC)
        const tookMs = performance.now() - startedAt

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(85)
        // The old watcher sat on the removed element for the full 10s.
        expect(tookMs).toBeLessThan(4000)
    }, 15000)

    it('a total re-drawn as "Updating…" first is read once the number lands', async () => {
        document.getElementById('apply').addEventListener('click', () => {
            setTimeout(() => redrawTotal('Updating…'), 100)
            setTimeout(() => redrawTotal('$90.00'), 500)
        })

        const startedAt = performance.now()
        const res = await applyCoupon('SAVE10', REC)
        const tookMs = performance.now() - startedAt

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
        expect(tookMs).toBeLessThan(4000)
    }, 15000)
})

describe('waitForTotalChange', () => {
    const find = () => document.getElementById('total')

    it('answers when the store replaces the total with a different amount', async () => {
        setTimeout(() => redrawTotal('$85.00'), 50)
        await expect(waitForTotalChange(find, '$100.00', 2000)).resolves.toBe(
            'text-changed',
        )
    })

    it('answers when the same element changes, as before', async () => {
        setTimeout(() => setText(find(), '$85.00'), 50)
        await expect(waitForTotalChange(find, '$100.00', 2000)).resolves.toBe(
            'text-changed',
        )
    })

    it('a total re-drawn with the same amount is no answer', async () => {
        setTimeout(() => redrawTotal('$100.00'), 50)
        await expect(waitForTotalChange(find, '$100.00', 600)).resolves.toBe(
            'price-nochange',
        )
    })

    it('a reading with no number in it is no answer yet', async () => {
        setTimeout(() => redrawTotal('Updating…'), 50)
        await expect(waitForTotalChange(find, '$100.00', 600)).resolves.toBe(
            'price-nochange',
        )
    })

    it('a total that is briefly gone is no answer', async () => {
        setTimeout(() => find().remove(), 50)
        await expect(waitForTotalChange(find, '$100.00', 600)).resolves.toBe(
            'price-nochange',
        )
    })

    it('resolves, never rejects, when nothing changes', async () => {
        await expect(waitForTotalChange(find, '$100.00', 300)).resolves.toBe(
            'price-nochange',
        )
    })
})
