import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * applyCoupon() must report the total that MOVED, not the biggest number in the
 * price container.
 *
 * savings-plausibility.test.mjs pins the other half of this — that a stray
 * "$500 off" banner can't INFLATE a claimed saving — but it stubs applyCoupon
 * out entirely and feeds the runner a `newTotal` by hand. That left the read
 * itself untested, and it was wrong: `newTotal` came from
 * `getPrice(container, { returnLargest: true })`, which on a container holding
 * an MSRP strikethrough alongside the order total returns the strikethrough.
 * It is identical before and after the code applies, so `priceDropped` is
 * false, the runner measures a saving of exactly zero, and the user is told
 *
 *     "Code SAVE12 is on your cart but hasn't changed the total yet —
 *      it may need a minimum spend to kick in."
 *
 * while the cart in front of them went from $120.00 to $108.00. Reproduced in a
 * real browser against naturepedic.com's live config on 2026-08-04.
 *
 * These drive the REAL applyCoupon against a real (jsdom) checkout.
 */

let applyCoupon

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    successIndicator: '#applied-row',
}

/** jsdom implements no layout, so innerText is undefined and nothing is
 *  "visible". Both are stubbed the same way the sibling suites do it. */
function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

/** Wires the fake checkout: clicking Apply rewrites the price container to
 *  `afterText` and mounts the applied row.
 *
 *  The response is deferred a tick on purpose. applyCoupon snapshots the
 *  applied-row count AFTER dispatching the click, so a checkout that reacts
 *  synchronously is already "applied" by the time the waiter starts and the
 *  waiter then burns its full 10s window seeing no change. Real checkouts
 *  round-trip; this one does too. */
function onApply(afterText) {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(() => {
            setTotalText(afterText)
            const row = document.createElement('div')
            row.id = 'applied-row'
            document.body.appendChild(row)
        }, 150)
    })
}

/** jsdom implements no layout, so nothing reports itself visible. */
function alwaysVisible() {
    return true
}

// jsdom performs no layout, so dom-utils' _isVisible fails closed on every
// element and applyCoupon would refuse the input it was handed. The old suite
// replaced the global `_isVisible` with `el => !!el`; the ES-module version
// gives the REAL one the same answer by implementing the one signal it reads.
// It cannot be replaced through vi.mock here: coupon-apply.js also imports the
// live `_caramelLastPrices` binding dom-utils' getPrice writes, and a mock
// factory's spread would freeze that at its initial [] — silently emptying the
// multi-price reading this file exists to pin.
beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = alwaysVisible
})

beforeEach(async () => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    // `_caramelLastPrices` is module state now, and an import binding cannot be
    // assigned — a fresh module registry per test is what the old
    // `globalThis._caramelLastPrices = []` was reaching for.
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
})

describe('applyCoupon — the post-apply total on a multi-price container', () => {
    it('reads the discounted total, not the untouched MSRP beside it', async () => {
        setTotalText('$120.00 $500.00')
        onApply('$108.00 $500.00')

        const res = await applyCoupon('SAVE12', REC)

        expect(res.success).toBe(true)
        // The bug returned 500 here, which the runner then measured as a
        // zero-saving "needs a minimum spend".
        expect(res.newTotal).toBe(108)
    })

    it('still measures a plain single-price cart exactly as before', async () => {
        setTotalText('$120.00')
        onApply('$108.00')

        const res = await applyCoupon('SAVE12', REC)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(108)
    })

    it('does not mistake a standing second line for a discounted total', async () => {
        // Shipping was already showing at $5.00 and the code did nothing. A
        // rule of "take the smallest number after applying" would call this a
        // $115 win; requiring the candidate to be NEW keeps it honest.
        setTotalText('$5.00 $120.00')
        onApply('$5.00 $120.00')

        const res = await applyCoupon('NOTHING', REC)

        expect(res.newTotal).toBe(120)
    })

    it('reports no drop when the total is unchanged', async () => {
        setTotalText('$120.00 $500.00')
        onApply('$120.00 $500.00')

        const res = await applyCoupon('NOTHING', REC)

        // Nothing moved, so the largest reading stands and the runner's
        // baseline math yields a saving of zero rather than a claim.
        expect(res.newTotal).toBe(500)
    })
})
