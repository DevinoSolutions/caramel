import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// Submitting a promo code on a classic checkout is a form POST: the page
// navigates and takes the content script, the overlay, and everything the run
// knew with it.
//
// 1800petmeds.com (QA sweep 2026-08-05): THEO20 came off the order for a real
// $14.78 and the user was told NOTHING for the ~180s they sat there — the fresh
// document re-inserted the "Try Caramel Coupons" pill as if the extension had
// never run. The money was delivered; the product looked dead.
//
// The fix hands the attempt across the navigation, but carries only what was
// known BEFORE the submit. Whether it worked is measured on the new page. That
// asymmetry is the whole point, and most of what this file pins: a tool that
// treats "we submitted and the page reloaded" as success is a tool that claims
// savings its users never got.

let caramelMarkPendingSubmit
let caramelTakePendingSubmit
let startCheckoutDetection
let finalModalCalls
let recordedSavings
let reportedOutcomes

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
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
    ;({ caramelMarkPendingSubmit, caramelTakePendingSubmit } =
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
            ['caramelMarkPendingSubmit', 'caramelTakePendingSubmit'],
        ))
    startCheckoutDetection = globalThis.startCheckoutDetection
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    finalModalCalls = []
    recordedSavings = []
    reportedOutcomes = []

    globalThis.getDomainRecord = async () => REC
    globalThis.getCachedCodes = async () => [
        { code: 'THEO20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    globalThis.insertCaramelPrompt = () => {
        // Standing in for the defect: before the handoff existed, the fresh
        // page's only response to a completed attempt was to prompt again.
        const pill = document.createElement('div')
        pill.id = 'caramel-small-prompt'
        document.body.appendChild(pill)
    }
    globalThis.isCheckout = async () => true
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    globalThis.caramelRecordSaving = s => recordedSavings.push(s)
    globalThis.reportOutcome = (id, outcome) =>
        reportedOutcomes.push({ id, outcome })
})

describe('dom-utils.js — the pending-submit record', () => {
    it('round-trips the code, its id, and the prices seen before submitting', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9, 59.12])

        expect(caramelTakePendingSubmit()).toEqual({
            code: 'THEO20',
            id: 'c1',
            prices: [73.9, 59.12],
        })
    })

    it('records no outcome at all — only what was known before the submit', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        const stored = JSON.parse(
            sessionStorage.getItem('caramel_pending_submit'),
        )

        expect(stored).not.toHaveProperty('saved')
        expect(stored).not.toHaveProperty('success')
    })

    it('is consumed on read, so an attempt is announced once and not again', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        expect(caramelTakePendingSubmit()).not.toBeNull()
        expect(caramelTakePendingSubmit()).toBeNull()
    })

    it('ignores a record from a visit the user has moved on from', () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        expect(caramelTakePendingSubmit(0)).toBeNull()
    })

    it('survives blocked storage without throwing', () => {
        expect(() =>
            caramelMarkPendingSubmit('THEO20', 'c1', [Number.NaN]),
        ).not.toThrow()
        // NaN is not JSON — it would have deserialised as null and poisoned the
        // baseline maths, so it never gets stored in the first place.
        expect(caramelTakePendingSubmit().prices).toEqual([])
    })
})

describe('coupon-runner.js — the record is written before the submit', () => {
    // If it were written after, the navigating case — the only case it exists
    // for — would never write one at all.
    const RUNNER_REC = { ...REC }

    beforeEach(() => {
        document.body.innerHTML =
            '<input id="promo" /><button id="apply">Apply</button>'
        setTotalText('Order Total $73.90')
        globalThis._caramelCancelled = false
        globalThis.getCoupons = async () => [{ code: 'THEO20', id: 'c1' }]
        globalThis._getTriedCodes = () => ({})
        globalThis._markTriedCode = () => {}
        globalThis._unmarkTriedCode = () => {}
        globalThis.probeCartJson = async () => null // non-Shopify: DOM path
        globalThis._isVisible = () => true // jsdom has no layout
        globalThis.waitUntilReady = async () => {}
        globalThis.showTestingModal = async () => {}
        globalThis.updateTestingModal = async () => {}
        globalThis.hideTestingModal = () => {}
        globalThis.reportOutcome = () => {}
    })

    it('has the attempt on record while the code is in flight', async () => {
        let inFlight = null
        globalThis.applyCoupon = async () => {
            // Stands in for the form POST: this is the moment the real page
            // navigates and this content script stops existing.
            inFlight = caramelTakePendingSubmit()
            return {
                success: false,
                newTotal: 73.9,
                committed: false,
                errorMsg: null,
            }
        }

        await globalThis.startApplyingCoupons(RUNNER_REC)

        expect(inFlight).not.toBeNull()
        expect(inFlight.code).toBe('THEO20')
        expect(inFlight.id).toBe('c1')
        expect(inFlight.prices).toContain(73.9)
    })

    it('leaves nothing behind when the attempt returns normally', async () => {
        globalThis.applyCoupon = async () => ({
            success: false,
            newTotal: 73.9,
            committed: false,
            errorMsg: null,
        })

        await globalThis.startApplyingCoupons(RUNNER_REC)

        expect(caramelTakePendingSubmit()).toBeNull()
    })
})

describe('store-detect.js — the page after the navigation', () => {
    it('reports a measured win instead of leaving the user in silence', async () => {
        // $73.90 before, $59.12 after: the real 1800petmeds numbers.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(finalModalCalls).toHaveLength(1)
        const [amount, code] = finalModalCalls[0]
        expect(amount).toBeCloseTo(14.78, 2)
        expect(code).toBe('THEO20')
    })

    it('banks the measured win and credits the coupon', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(recordedSavings).toHaveLength(1)
        expect(recordedSavings[0].amount).toBeCloseTo(14.78, 2)
        expect(recordedSavings[0].code).toBe('THEO20')
        expect(reportedOutcomes).toEqual([{ id: 'c1', outcome: 'worked' }])
    })

    it('does not re-prompt as if the attempt had never happened', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $59.12')

        await startCheckoutDetection()

        expect(document.getElementById('caramel-small-prompt')).toBeNull()
    })

    it('claims nothing when the total did not move', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        const [amount, code, message] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/hasn't changed/i)
        expect(recordedSavings).toEqual([])
    })

    it('does not blame the coupon for a page that navigated', async () => {
        // The runner's rule, held here too: only the store's own rejection
        // words count as evidence against a code.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        expect(reportedOutcomes).toEqual([])
    })

    it('offers the OTHER codes, not the one that just failed to move it', async () => {
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        const list = finalModalCalls[0][4] ?? []
        expect(list.map(c => c.code)).toEqual(['SPRING10'])
    })

    it('says it cannot tell, rather than guessing, when nothing is readable', async () => {
        // No price on the page at all — the case where treating "submitted +
        // reloaded" as success would invent a saving.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])

        await startCheckoutDetection()

        const [amount, code, message] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/check your order summary/i)
        expect(recordedSavings).toEqual([])
        expect(reportedOutcomes).toEqual([])
    })

    it('never turns a price RISE into a saving', async () => {
        // Shipping added after the reload: the tightest-baseline rule has no
        // candidate at or above the new total, so there is no figure to claim.
        caramelMarkPendingSubmit('THEO20', 'c1', [73.9])
        setTotalText('Order Total $81.40')

        await startCheckoutDetection()

        expect(finalModalCalls[0][0]).toBe(0)
        expect(recordedSavings).toEqual([])
    })

    it('leaves an ordinary page alone when no attempt was interrupted', async () => {
        // Guards the guard: with no pending record the fresh-page path must go
        // back to normal detection, not swallow it.
        setTotalText('Order Total $73.90')

        await startCheckoutDetection()

        expect(finalModalCalls).toEqual([])
        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })
})
