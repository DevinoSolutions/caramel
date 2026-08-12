import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { removeAppliedCoupon } from '../coupon-apply.js'
import { startApplyingCoupons } from '../coupon-runner.js'

// A cart that ALREADY has a discount on it is the most expensive thing this
// flow can get wrong, and the DOM path got it wrong twice over.
//
// 1. Cleanup between codes clicked the LAST visible remove button, reasoning
//    that the newest coupon renders last. On a cart where the shopper had
//    applied their own code, that is a coin flip — and losing it takes money
//    off their order through an action they never asked for.
// 2. The closing message read "Auto-apply didn't stick this time. Copy a code
//    and paste it in the store's promo box" — over a live discount. On most
//    checkouts a second code REPLACES the first, so following that advice is
//    what costs the money. The discount-link path already learned this against
//    real carts (goodr -$8.00, 1thrive -$20.00); this is the same honesty for
//    the path that drives the form.

// Collaborators the old suite replaced by assigning over a global are replaced
// through module mocks now; a factory forwards to a per-test slot so a
// beforeEach still reads as one assignment. removeAppliedCoupon is deliberately
// NOT among them — the cleanup path it drives is what this file pins.
const stubs = vi.hoisted(() => ({
    applyCoupon: null,
    getCoupons: null,
    finalModalCalls: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // Assigned by initCaramelBase(); a spread would freeze it at undefined.
        get currentBrowser() {
            return actual.currentBrowser
        },
        // The cleanup path waits ~600ms after each click for the cart to settle,
        // and the loop pauses between codes — see the note in beforeEach.
        sleep: async () => {},
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: (...args) => stubs.applyCoupon(...args),
    probeCartJson: async () => null, // non-Shopify: DOM path
    _getTriedCodes: () => ({}),
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: (...args) => stubs.getCoupons(...args),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let finalModalCalls
let removedRows
let reportedOutcomes

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
    successIndicator: '.applied-coupon',
    couponRemove: '.applied-coupon button',
}

/** jsdom leaves innerText undefined; getPrice reads it. */
function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

/** Renders an applied-discount row with its own remove button. */
function addAppliedRow(code) {
    const row = document.createElement('div')
    row.className = 'applied-coupon'
    row.textContent = `${code} applied `
    const button = document.createElement('button')
    button.textContent = 'Remove'
    button.addEventListener('click', () => {
        removedRows.push(code)
        row.remove()
    })
    row.appendChild(button)
    document.body.appendChild(row)
    return row
}

/** jsdom implements no layout, so nothing reports itself visible. */
function alwaysVisible() {
    return true
}

beforeAll(() => {
    // reportOutcome() lives in coupon-runner.js and is called from inside
    // coupon-runner.js, so no module mock can stand in front of it. What it
    // DOES is send one runtime message — so the message is what gets recorded,
    // and "no verdict was sent" is pinned as "no message was sent".
    globalThis.chrome = {
        runtime: {
            sendMessage: msg => {
                if (msg?.action !== 'reportOutcome') return
                reportedOutcomes.push({
                    id: msg.id,
                    outcome: msg.outcome,
                    storeReason: msg.storeReason,
                })
            },
        },
    }
    initCaramelBase()
    // jsdom has no layout, so the real _isVisible fails closed on every element.
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = alwaysVisible
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Order Total $80.00')
    removedRows = []
    finalModalCalls = stubs.finalModalCalls = []
    reportedOutcomes = []
    globalThis._caramelCancelled = false

    stubs.getCoupons = async () => [
        { code: 'TRYME', id: 'c1' },
        { code: 'ORME', id: 'c2' },
    ]
    // Every code "commits" a row and then errors — the exact state that
    // triggers cleanup.
    stubs.applyCoupon = async code => {
        addAppliedRow(code)
        return {
            success: false,
            newTotal: 80,
            committed: true,
            errorMsg: 'Not valid for these items',
            // The store said it BECAUSE of this attempt — see
            // tests/store-said-attribution.test.mjs for what that gate means.
            errorIsNew: true,
        }
    }
})

describe('cleanup never removes a discount we did not add', () => {
    it("removes our own code's row, not the shopper's", async () => {
        addAppliedRow('SHOPPER50') // theirs, applied before we ran

        await startApplyingCoupons(REC)

        expect(removedRows).not.toContain('SHOPPER50')
        expect(removedRows).toEqual(['TRYME', 'ORME'])
    })

    it('leaves the cart alone when it cannot tell which row is ours', async () => {
        // Their discount is there; our code commits a row that does NOT name
        // the code (some checkouts render a generic "Discount" line). Removing
        // the only identifiable row would take theirs.
        addAppliedRow('SHOPPER50')
        stubs.applyCoupon = async () => ({
            success: false,
            newTotal: 80,
            committed: true,
            errorMsg: 'Not valid for these items',
            // The store said it BECAUSE of this attempt — see
            // tests/store-said-attribution.test.mjs for what that gate means.
            errorIsNew: true,
        })

        await startApplyingCoupons(REC)

        expect(removedRows).toEqual([])
        expect(document.querySelectorAll('.applied-coupon')).toHaveLength(1)
    })

    it('still cleans up normally on a cart that arrived with no discount', async () => {
        // Guards the guard: the refusal must not stop ordinary cleanup, or
        // every failed code would stack up on the cart.
        await startApplyingCoupons(REC)

        expect(removedRows).toEqual(['TRYME', 'ORME'])
    })

    it('removes nothing at all when asked about a cart it did not change', async () => {
        addAppliedRow('SHOPPER50')

        const removed = await removeAppliedCoupon(REC, {
            code: 'OURCODE',
            hadPreExisting: true,
        })

        expect(removed).toBe(false)
        expect(removedRows).toEqual([])
    })
})

describe('an already-discounted cart is not reported as a failure', () => {
    it('names the live discount instead of blaming the codes', async () => {
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/already has a discount/i)
        expect(message).not.toMatch(/didn't stick/i)
    })

    it('warns that pasting another code may replace it', async () => {
        // The copy list is still offered — a shopper may genuinely want to
        // swap — but never without saying what a swap costs.
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2]).toMatch(/may replace/i)
        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it("still repeats the store's own words, and still warns", async () => {
        // The store's reason is the most useful thing we have and keeps
        // leading. What it must NOT keep is its usual "copy a code and paste
        // it" tail — that advice is precisely what costs the money here.
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/Not valid for these items/)
        expect(message).toMatch(/may replace/i)
        expect(message).not.toMatch(/paste it in the store's promo box/i)
    })

    it('says nothing about a pre-existing discount on a clean cart', async () => {
        stubs.applyCoupon = async () => ({
            success: false,
            newTotal: 80,
            committed: false,
            errorMsg: null,
        })

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2] ?? '').not.toMatch(
            /already has a discount/i,
        )
    })
})

// The modal told this shopper the truth; the BACKEND was told a lie. Same run,
// same rejection text, two different audiences — and only one of them was
// fixed. A store that refuses a second code ("cannot be combined with the
// discount already applied") produces error text with no rejection vocabulary
// in it, which coupon-apply.js hands back verbatim, and the no-win path spent
// it as a 'failed' verdict on a coupon that is in perfect health. That verdict
// outlives the session and follows the code to every future shopper.
describe('a rejection caused by the shopper’s own discount is not a coupon verdict', () => {
    it('sends no failure verdict when the cart already carried a discount', async () => {
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        // The run still ends with no win, and the shopper still sees why.
        expect(finalModalCalls[0][2]).toMatch(/already has a discount/i)
        expect(reportedOutcomes).toEqual([])
    })

    it("withholds it even when the store's words sound like a code problem", async () => {
        // The exact trap: wording that reads as a verdict on the code, on a
        // cart where it cannot be one. There is no neutral outcome to send in
        // its place — the endpoint takes 'worked' or 'failed' and nothing else
        // — so the honest report is no report.
        addAppliedRow('SHOPPER50')
        stubs.applyCoupon = async () => ({
            success: false,
            newTotal: 80,
            committed: true,
            errorMsg:
                'This code cannot be combined with the discount already applied',
            errorIsNew: true,
        })

        await startApplyingCoupons(REC)

        expect(reportedOutcomes).toEqual([])
    })

    it('still reports the failure when the cart arrived clean', async () => {
        // Guards the guard. The suppression is scoped to the one situation
        // that makes the evidence unattributable; everywhere else the trust
        // loop must keep learning, or the fix costs more signal than the bug.
        await startApplyingCoupons(REC)

        expect(reportedOutcomes).toEqual([
            {
                id: 'c2', // the last code to produce real rejection text
                outcome: 'failed',
                storeReason: 'Not valid for these items',
            },
        ])
    })
})

// The other half of the same cart: our code went in, the store took it, and
// the total never moved — which on an already-discounted cart is what "they
// won't combine" looks like from the winning side. This branch knew about the
// live discount (it had the same snapshot) and still hedged at the shopper
// with "a discount you already have", then sent them off to paste codes
// without the warning its sibling treats as mandatory.
describe('a code that changed nothing on a discounted cart says so plainly', () => {
    beforeEach(() => {
        // Accepted, committed, total identical → the zero-effect branch.
        stubs.applyCoupon = async code => {
            addAppliedRow(code)
            return { success: true, newTotal: 80, committed: true }
        }
    })

    it('names the live discount and warns what pasting another costs', async () => {
        addAppliedRow('SHOPPER50')

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/already has a discount/i)
        expect(message).toMatch(/may replace/i)
        // The guess is gone: we can SEE the discount, so we stop offering a
        // minimum spend as the likely explanation.
        expect(message).not.toMatch(/minimum spend/i)
        // The codes are still handed over — a shopper may want to swap.
        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it('keeps the original hedge when no discount was on the cart', async () => {
        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2] ?? ''
        expect(message).toMatch(/minimum spend/i)
        expect(message).not.toMatch(/may replace/i)
        expect(message).not.toMatch(/already has a discount/i)
    })
})
