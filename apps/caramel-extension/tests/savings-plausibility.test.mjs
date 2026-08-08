import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// A store config is refined continuously and is WRONG for long stretches. The
// costliest way it can be wrong is `price_container_xpath`: getPrice() takes the
// LARGEST number inside whatever element the config names, so a selector aimed
// at an MSRP strikethrough or a "save up to $500" banner inflates the cart's
// "original" price. `original - newTotal` then yields a headline savings figure
// the user never actually received — the one failure mode that costs trust
// outright, and that the user cannot detect by looking at the modal.
//
// These pin the plausibility gate in coupon-runner.js: a claimed saving must fit
// INSIDE the cart it was measured against.

let startApplyingCoupons
let finalModalCalls
let recordedSavings

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    applyButton: '#apply',
    priceContainer: '#total',
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    let el = document.getElementById('total')
    if (!el) {
        el = document.createElement('div')
        el.id = 'total'
        document.body.appendChild(el)
    }
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

beforeAll(() => {
    loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['startApplyingCoupons'],
    )
    startApplyingCoupons = globalThis.startApplyingCoupons
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>'
    globalThis._caramelCancelled = false
    finalModalCalls = []
    recordedSavings = []

    // Collaborators stubbed so the test drives the runner's DECISION logic,
    // not the network, the overlay chrome, or a real checkout.
    globalThis.getCoupons = async () => [{ code: 'SAVE10', id: 'c1' }]
    globalThis._getTriedCodes = () => ({})
    globalThis.probeCartJson = async () => null // force the DOM form path
    globalThis._isVisible = () => true // jsdom has no layout
    globalThis.waitUntilReady = async () => {}
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = s => recordedSavings.push(s)
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
})

describe('coupon-runner.js — a claimed saving must fit inside the cart', () => {
    it('ignores a promo banner in the price container and reports the REAL saving', async () => {
        // The config's selector is too broad: the container holds a "$500 off"
        // banner as well as the order total, and getPrice(returnLargest) reads
        // 500. Measuring off that would headline $462.20.
        setTotalText('Save up to $500 today! Order total: $42.00')
        globalThis.applyCoupon = async () => ({
            success: true,
            newTotal: 37.8,
            committed: true,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls).toHaveLength(1)
        const [amount, code] = finalModalCalls[0]
        expect(amount).not.toBeCloseTo(462.2, 1) // the naive arithmetic
        expect(amount).toBeCloseTo(4.2, 2) // 42.00 - 37.80, the truth
        expect(code).toBe('SAVE10')
        // and the user's lifetime total banks the real figure, not the banner
        expect(recordedSavings).toHaveLength(1)
        expect(recordedSavings[0].amount).toBeCloseTo(4.2, 2)
    })

    it('does not tell the user the total "hasn\'t changed" when it demonstrably did', async () => {
        setTotalText('Order total: $42.00')
        globalThis.applyCoupon = async () => ({
            success: true,
            // Dropped below the cart, but the container no longer shows a
            // number at or above it — no defensible baseline to measure from.
            newTotal: 55,
            committed: true,
        })

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2]
        // The min-spend copy would be a plain lie about their own cart here.
        expect(message ?? '').not.toMatch(/hasn't changed the total/i)
        expect(message ?? '').not.toMatch(/minimum spend/i)
    })

    it('still reports a normal, believable saving (happy path intact)', async () => {
        setTotalText('Order total: $42.00')
        globalThis.applyCoupon = async () => ({
            success: true,
            newTotal: 37.8,
            committed: true,
        })

        await startApplyingCoupons(REC)

        const [amount, code] = finalModalCalls[0]
        expect(amount).toBeCloseTo(4.2, 2)
        expect(code).toBe('SAVE10')
        expect(recordedSavings).toHaveLength(1)
        expect(recordedSavings[0]).toMatchObject({
            code: 'SAVE10',
            amount: expect.closeTo(4.2, 2),
        })
    })

    it('claims nothing when the "new" total is HIGHER than the original', async () => {
        // Mis-measurement or a re-rendered total that grew — either way this is
        // not a saving and must never render as one.
        setTotalText('Order total: $42.00')
        globalThis.applyCoupon = async () => ({
            success: true,
            newTotal: 55,
            committed: true,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][0]).toBe(0)
        expect(recordedSavings).toEqual([])
    })

    it('allows a full 100%-off saving (equal to the total) — the boundary is inclusive', async () => {
        setTotalText('Order total: $42.00')
        globalThis.applyCoupon = async () => ({
            success: true,
            newTotal: 0,
            committed: true,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][0]).toBeCloseTo(42, 2)
        expect(recordedSavings).toHaveLength(1)
    })
})

// --- scraped codes are dirty strings ---------------------------------------
// A code is typed into the store's input verbatim and handed to the clipboard
// verbatim. Whitespace the scraper carried over turns a working code into a
// store rejection, which the trust loop then records against the coupon.

describe('coupon-fetch.js — scraped codes are normalised before use', () => {
    it('strips surrounding whitespace, newlines and zero-width characters', () => {
        const clean = globalThis._caramelCleanCodes([
            { code: '  SAVE10\n' },
            { code: '\u200bWELCOME20\ufeff' },
            { code: 'NBSP\u00a0END' },
            { code: 'ALREADYFINE' },
        ])
        expect(clean.map(c => c.code)).toEqual([
            'SAVE10',
            'WELCOME20',
            'NBSP END', // internal space preserved — some stores issue these
            'ALREADYFINE',
        ])
    })

    it('drops codes that are empty once cleaned, and leaves the array otherwise intact', async () => {
        const clean = globalThis._caramelCleanCodes([
            { code: '   ' },
            { code: '\u200b' },
            { code: 'REAL5', title: 'keeps its other fields' },
        ])
        expect(clean).toHaveLength(1)
        expect(clean[0]).toMatchObject({
            code: 'REAL5',
            title: 'keeps its other fields',
        })
    })

    it('passes a non-array through untouched (cold cache / fetch failure)', () => {
        expect(globalThis._caramelCleanCodes(null)).toBeNull()
        expect(globalThis._caramelCleanCodes(undefined)).toBeUndefined()
    })
})

// --- the extension must never drive a checkout's own order button -----------
// pickBestMatch falls back to "first visible match on the page", so an
// over-broad apply/showInput selector can resolve to "Place your order". The
// apply path dispatches a full pointer+click sequence, which such a button
// accepts. A wrong config must cost a missed discount, never a real purchase.

describe('dom-utils.js — order-completing controls are refused', () => {
    const forbidden = [
        'Place your order',
        'Place order',
        'Pay now',
        'Complete purchase',
        'Complete your order',
        'Submit order',
        'Confirm and pay',
        'Buy now',
        'Proceed to checkout',
        'Remove item',
    ]
    const allowed = [
        'Apply',
        'Apply promo code',
        'Apply discount',
        'Have a promo code?',
        'Submit',
        'Add code',
        'Enter code',
    ]

    const el = (text, attrs = {}) => {
        const n = document.createElement('button')
        n.textContent = text
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
        return n
    }

    it.each(forbidden)('refuses %s', label => {
        expect(globalThis.caramelIsForbiddenControl(el(label))).toBe(true)
    })

    it.each(allowed)('allows a real coupon control: %s', label => {
        expect(globalThis.caramelIsForbiddenControl(el(label))).toBe(false)
    })

    it('also inspects aria-label, value, name and id — not just visible text', () => {
        expect(
            globalThis.caramelIsForbiddenControl(
                el('', { 'aria-label': 'Place your order' }),
            ),
        ).toBe(true)
        expect(
            globalThis.caramelIsForbiddenControl(el('', { id: 'pay-now' })),
        ).toBe(true)
        expect(
            globalThis.caramelIsForbiddenControl(
                el('', { name: 'submit-order' }),
            ),
        ).toBe(true)
    })

    it('treats a missing element as not-forbidden (callers handle null themselves)', () => {
        expect(globalThis.caramelIsForbiddenControl(null)).toBe(false)
        expect(globalThis.caramelIsForbiddenControl(undefined)).toBe(false)
    })
})

// --- removing a coupon must never remove the user's items -------------------
// removeAppliedCoupon runs BETWEEN failed codes (up to 8x a run). Its generic
// fallback is hardcoded in the extension, not supplied by config, so it is the
// default on every store that doesn't set couponRemove. Three of its selectors
// name no coupon context at all — on a cart page they equally match
// "Remove item".

describe('coupon-apply.js — remove-coupon never targets a cart line item', () => {
    const CART = `
        <ul class="cart-items">
          <li class="line-item">Silk pyjama top
            <button aria-label="Remove item">x</button></li>
          <li class="line-item">Slippers
            <button aria-label="Remove item">x</button></li>
        </ul>
        <div class="promo-block">
          <input id="promo" value="SAVE10" />
          <div class="applied-coupon"><button aria-label="Remove">x</button></div>
        </div>`

    let clicked

    beforeEach(() => {
        document.body.innerHTML = CART
        clicked = []
        for (const b of document.querySelectorAll('button')) {
            b.addEventListener('click', e =>
                clicked.push(e.currentTarget.getAttribute('aria-label')),
            )
        }
        globalThis._isVisible = () => true
    })

    it('clicks the coupon-scoped remove, not the last "Remove item" on the page', async () => {
        await globalThis.removeAppliedCoupon({ couponInput: '#promo' })
        expect(clicked).toEqual(['Remove'])
        expect(clicked).not.toContain('Remove item')
    })

    it('does not touch line items when the coupon block has no remove button', async () => {
        document.querySelector('.applied-coupon').remove()

        const removed = await globalThis.removeAppliedCoupon({
            couponInput: '#promo',
        })

        // No coupon-area remove exists, so the line-item buttons must be left
        // alone — it falls back to clearing the input instead.
        expect(clicked).toEqual([])
        expect(document.getElementById('promo').value).toBe('')
        expect(removed).toBe(true)
    })

    it('never clicks a bare unscoped "Remove", even inside the promo block', async () => {
        // The unscoped tier is gone on purpose. A line item's bare "Remove" and
        // a coupon's bare "Remove" are identical in label AND in DOM shape on a
        // shallow cart — two proximity guards were measured and neither could
        // separate them. So an unscoped match is never clicked at all; the
        // store's config must name it via `couponRemove` to be actionable.
        document.querySelector('.applied-coupon').outerHTML =
            '<button aria-label="Remove">x</button>'
        for (const b of document.querySelectorAll('button')) {
            b.addEventListener('click', e =>
                clicked.push(e.currentTarget.getAttribute('aria-label')),
            )
        }
        clicked.length = 0

        await globalThis.removeAppliedCoupon({ couponInput: '#promo' })
        expect(clicked).toEqual([])
        expect(document.getElementById('promo').value).toBe('')
    })

    it('DOES click an unscoped remove when the store config names it explicitly', async () => {
        // Per-store `couponRemove` is a deliberate decision, not a blind
        // default — so it is honoured even though it is unscoped.
        document.querySelector('.applied-coupon').outerHTML =
            '<button id="cpnRemove" aria-label="Remove">x</button>'
        document
            .getElementById('cpnRemove')
            .addEventListener('click', () => clicked.push('config-remove'))

        await globalThis.removeAppliedCoupon({
            couponInput: '#promo',
            couponRemove: '#cpnRemove',
        })
        expect(clicked).toEqual(['config-remove'])
    })
})
