import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { applyCoupon } from '../coupon-apply.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    NO_CONFIG,
    PROMO_BOX,
    handoffs,
    installChromeStub,
    registerFinder,
    sent,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// A code that takes the whole order to $0.00 in its OWN attempt, on a box the
// finder picked (T-11045).
//
// neweracap.com (1.4.28, 2026-10-30): "Free" took the order from $38.99 to
// $0.00 and Shopify drew its "FREE" discount tag, but the attempt was recorded
// as failed with the total read as $38.99: the finder reads a $0.00 total as a
// half-drawn page. A zero now counts only when the order names the code (the
// same rule as the late credit, T-10544); a bare zero still does not.

const stubs = vi.hoisted(() => ({ finalModalCalls: [], removed: [] }))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    removeAppliedCoupon: async (_rec, opts) => {
        stubs.removed.push(opts?.code)
    },
    probeCartJson: async () => null, // a checkout form: the DOM path
    _getTriedCodes: () => ({}),
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        ['Free', 'Freeship'].map((code, i) => ({ code, id: `c${i}` })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

// The verdict waits up to 10s for a store that never answers.
const SLOW = 30000

const TOTAL =
    '<div class="row"><span>Total</span><span id="tot">USD $38.99</span></div>'

/** Shopify's tag for an applied code, as neweracap.com drew it (the markup of
 *  late-code-credited-shopify-discount-tags.test.mjs). */
const tag = code =>
    `<li><div id="tag-0" role="group"><div><div><div>` +
    `<span><svg aria-hidden="true"></svg></span>` +
    `<span><span aria-hidden="true" dir="auto"><span>${code}</span></span></span>` +
    `</div><span dir="auto">${code}</span></div></div>` +
    `<button aria-label="Remove ${code}" data-event-name="remove_discount_code" type="button">` +
    `<span><svg aria-hidden="true"></svg></span></button></div></li>`

/** On Apply, the store takes the order to $0.00, drawing `tagFor` (if any). */
function storeZeroesTheOrder(tagFor) {
    document.getElementById('ap').addEventListener('click', () => {
        setTimeout(() => {
            if (tagFor) {
                const list = document.createElement('ul')
                list.setAttribute('role', 'list')
                list.setAttribute('aria-label', 'Discount code or gift card')
                list.innerHTML = tag(tagFor)
                document.body.appendChild(list)
            }
            document.getElementById('tot').textContent = 'USD $0.00'
        }, 100)
    })
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
    registerFinder()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    sent.length = 0
    setPath('/checkout')
    _caramelResetDiscoveryFlag()
    document.body.innerHTML = PROMO_BOX + TOTAL
    globalThis._caramelCancelled = false
    stubs.finalModalCalls = []
    stubs.removed = []
})

describe('a code that takes the order to $0.00 in its own attempt (T-11045)', () => {
    it(
        'is a success when the order names the code',
        async () => {
            storeZeroesTheOrder('FREE')
            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            expect(rec?.caramelFound).toBe(true)

            const res = await applyCoupon('Free', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(0)
        },
        SLOW,
    )

    it(
        'is not a success when no tag names the code',
        async () => {
            storeZeroesTheOrder(null)
            const rec = await caramelDiscoveredRecord(NO_CONFIG)

            const res = await applyCoupon('Free', rec)

            expect(res.success).toBe(false)
        },
        SLOW,
    )

    it(
        'is not a success when the tag names another code',
        async () => {
            storeZeroesTheOrder('STAFF100')
            const rec = await caramelDiscoveredRecord(NO_CONFIG)

            const res = await applyCoupon('Free', rec)

            expect(res.success).toBe(false)
        },
        SLOW,
    )

    it(
        'the run ends on that code and leaves it on the order',
        async () => {
            storeZeroesTheOrder('FREE')
            const rec = await caramelDiscoveredRecord(NO_CONFIG)

            await startApplyingCoupons(rec)

            const [saved, code] = stubs.finalModalCalls.at(-1)
            expect(code).toBe('Free')
            expect(saved).toBeCloseTo(38.99, 2)
            expect(stubs.removed).toEqual([])
            expect(document.getElementById('tot').textContent).toBe('USD $0.00')
        },
        SLOW,
    )
})
