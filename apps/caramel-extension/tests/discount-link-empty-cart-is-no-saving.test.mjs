import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
const handoffs = tabHandoffBackground()

// On the discount-link path the verdict is the cart's own total, read after
// each code. A total that falls to 0 because the cart has nothing left in it
// is not a saving: a live card once said "You saved £65.00 Code VIPBF15" (the
// whole order) for a code that does nothing when typed by hand, because the
// cart emptied while the codes were being tried. A drop counts only while the
// cart still holds items, and a total of 0 only when the cart also names the
// code as applied (a code that makes the order free).

const stubs = vi.hoisted(() => ({
    applyViaDiscountLink: null,
    probeCartJson: null,
    getCoupons: null,
    updateTestingModal: null,
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
        sleep: async () => {},
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    probeCartJson: (...args) => stubs.probeCartJson(...args),
    applyViaDiscountLink: (...args) => stubs.applyViaDiscountLink(...args),
    _getTriedCodes: () => ({}),
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
// getCoupons() reads its list from store-detect's getCachedCodes, and that is
// where the stub goes: coupon-fetch sits in the store-detect ↔ coupon-runner
// import cycle, so a mock of coupon-fetch loaded from here is bound too late —
// coupon-runner ends up holding the real getCoupons. Feeding the cache instead
// keeps the whole ranking path (_caramelCleanCodes → caramelRankByValue) real,
// which is the path this file is about.
vi.mock('../store-detect.js', async importOriginal => ({
    ...(await importOriginal()),
    getCachedCodes: (...args) => stubs.getCoupons(...args),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: (...args) => stubs.updateTestingModal(...args),
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let linkCalls
let finalModalCalls
let outcomeCalls
let carts

const REC = { domain: 'modainpelle.com' }

const BASE = 6500

function cart(total, { items = 1, codes = [] } = {}) {
    return {
        token: 't',
        total_price: total,
        item_count: items,
        discount_codes: codes,
        currency: 'GBP',
    }
}

/** jsdom implements no layout, so nothing reports itself visible. */
function alwaysVisible() {
    return true
}

beforeAll(() => {
    // reportOutcome() lives in coupon-runner.js and is called from inside
    // coupon-runner.js, so no module mock can stand in front of it. What it
    // DOES is send one runtime message — so the message is what gets recorded,
    // and "claims no win" is pinned as "nothing was sent".
    globalThis.chrome = {
        runtime: {
            sendMessage: (msg, cb) => {
                if (handoffs.answers(msg, cb)) return
                if (msg?.action !== 'reportOutcome') return
                outcomeCalls.push(
                    msg.storeReason === undefined
                        ? [msg.id, msg.outcome]
                        : [msg.id, msg.outcome, msg.storeReason],
                )
            },
        },
    }
    initCaramelBase()
    // jsdom performs no layout, so the real _isVisible fails closed on every
    // element; the old suite said "everything here is visible" by replacing it.
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = alwaysVisible
})

// The success path ends in location.reload(), so the store's own UI shows the
// discount. jsdom can't navigate and prints "Not implemented: navigation to
// another Document" for each one — and window.location is spec-non-configurable,
// so it genuinely cannot be stubbed out. The call is a no-op there; everything
// asserted below is written before it, which is also why it survives the reload
// in the real browser.

beforeEach(() => {
    handoffs.reset()
    document.body.innerHTML = ''
    sessionStorage.clear()
    linkCalls = []
    finalModalCalls = stubs.finalModalCalls = []
    outcomeCalls = []
    // What each code is really worth, independent of what its metadata claims.
    carts = {}
    globalThis._caramelCancelled = false
    stubs.updateTestingModal = async () => {}
    stubs.probeCartJson = async () => cart(BASE)
    stubs.applyViaDiscountLink = async code => {
        linkCalls.push(code)
        return carts[code] ?? null
    }
    // The metadata deliberately disagrees with reality, exactly as it did on
    // personalabs: the loud code is the weak one.
    stubs.getCoupons = async () => [
        { code: 'NOTHING10', id: 'c1' },
        { code: 'VIPBF15', id: 'c2' },
    ]
})

const applied = () => handoffs.peek('applied')

describe('a total that falls because the cart emptied is not a saving', () => {
    it('the cart empties mid-run: nothing is credited and the honest card is shown', async () => {
        carts = {
            NOTHING10: cart(BASE),
            // The store emptied the cart while this code was being tried.
            VIPBF15: cart(0, { items: 0 }),
        }

        await startApplyingCoupons(REC)

        expect(await applied()).toBeNull()
        expect(outcomeCalls).toEqual([])
        expect(finalModalCalls.at(-1)[0]).toBe(0)
    })

    it('the shopper removed the items: nothing is credited, even with the code still attached', async () => {
        carts = {
            NOTHING10: cart(0, { items: 0 }),
            VIPBF15: cart(0, {
                items: 0,
                codes: [{ code: 'VIPBF15', applicable: true, amount: 0 }],
            }),
        }

        await startApplyingCoupons(REC)

        expect(await applied()).toBeNull()
        expect(outcomeCalls).toEqual([])
    })

    it('a real drop with items still in the cart is credited', async () => {
        carts = {
            NOTHING10: cart(BASE),
            VIPBF15: cart(BASE - 975, {
                codes: [{ code: 'VIPBF15', applicable: true, amount: 975 }],
            }),
        }

        await startApplyingCoupons(REC)

        expect((await applied()).code).toBe('VIPBF15')
        expect((await applied()).saved).toBeCloseTo(9.75, 2)
        expect(outcomeCalls).toEqual([['c2', 'worked']])
    })

    it('a code that makes the order free is credited when the cart names it', async () => {
        carts = {
            NOTHING10: cart(BASE),
            VIPBF15: cart(0, {
                codes: [{ code: 'VIPBF15', applicable: true, amount: BASE }],
            }),
        }

        await startApplyingCoupons(REC)

        expect((await applied()).code).toBe('VIPBF15')
        expect((await applied()).saved).toBeCloseTo(65, 2)
    })

    it('a total of 0 with items but no code named is not credited', async () => {
        carts = { NOTHING10: cart(BASE), VIPBF15: cart(0) }

        await startApplyingCoupons(REC)

        expect(await applied()).toBeNull()
        expect(outcomeCalls).toEqual([])
    })
})
