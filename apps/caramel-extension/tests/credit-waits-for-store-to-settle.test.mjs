import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelUseLoadedFinder } from '../coupon-box-finder-loader.js'
import {
    CARAMEL_SETTLE_FULL_MS,
    CARAMEL_SETTLE_SHORT_MS,
    startApplyingCoupons,
} from '../coupon-runner.js'
import * as finder from './_finder-under-test.mjs'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// A code is credited only once the store has settled (T-11366).
//
// neweracap.com (1.4.30, 2026-10-31, timed from the click): "Free" took the
// order to $0.00 with a "FREE" tag at 15.0 s, the attempt was judged a success
// at 16.4 s and the run stopped. At 20.6 s the store took the tag away, and by
// 22.3 s the total was back at $38.99. The card kept "You saved $38.99", and
// the "worked" report (and, on a store with no config, the box save) had
// already gone out. The store reversed the code by itself, with or without the
// extension. The markup below is the live page's, as in
// late-code-credited-shopify-discount-tags.test.mjs.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    answers: {},
    applied: [],
    appliedAt: {},
    finalModalCalls: [],
    shownAt: null,
    sent: [],
    savings: [],
    codes: [],
    cart: null,
    linkCarts: {},
    clock: 0,
}))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async code => {
        stubs.applied.push(code)
        stubs.appliedAt[code] = stubs.clock
        return stubs.answers[code]()
    },
    removeAppliedCoupon: async () => {},
    // Null is a checkout form (the DOM path); a cart is the discount-link path.
    probeCartJson: async () => stubs.cart,
    applyViaDiscountLink: async code => {
        stubs.applied.push(code)
        const after = stubs.linkCarts[code] ?? null
        if (after) stubs.cart = after
        return after
    },
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
        caramelRecordSaving: entry => stubs.savings.push(entry),
    }
})
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        stubs.codes.map((code, i) => ({ code, id: `c${i}` })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => {
        stubs.shownAt = stubs.clock
        stubs.finalModalCalls.push(args)
    },
}))

// The box the finder found on a store with no config, saved when a code works
// through it (coupon-box-discovery.js caramelFinderConfirmed).
const BOX = {
    input: '#discount',
    apply: '#apply',
    total: '#summary [role="row"]',
}
const rec = () => ({
    domain: 'neweracap.com',
    couponInput: '[data-caramel-found="input"]',
    couponSubmit: '[data-caramel-found="submit"]',
    priceContainer: '[data-caramel-found="total"]',
    caramelTotalKind: 'total',
    caramelTotalLabel: 'total',
    caramelTotalRows: 1,
    errorIndicator: null,
    successIndicator: null,
    couponRemove: null,
    caramelFound: true,
    caramelSave: { ...BOX },
})

/** A Shopify cart as /cart.js returns it (amounts in cents). */
const cart = (total, codes = []) => ({
    token: 't',
    total_price: total,
    item_count: 1,
    discount_codes: codes,
    currency: 'USD',
})

/** Shopify's tag for an applied code, as neweracap.com drew it. */
const tag = code =>
    `<li><div id="tag-0" role="group"><div><div><div>` +
    `<span><svg aria-hidden="true"></svg></span>` +
    `<span><span aria-hidden="true" dir="auto"><span>${code}</span></span></span>` +
    `</div><span dir="auto">${code}</span></div></div>` +
    `<button aria-label="Remove ${code}" data-event-name="remove_discount_code" type="button">` +
    `<span><svg aria-hidden="true"></svg></span></button></div></li>`

function orderTags(html) {
    document.getElementById('tags').innerHTML = html
}
/** What the summary's Total row reads now. */
function totalReads(text) {
    const cell = document.querySelector(
        '[data-caramel-found="total"] [role="cell"]',
    )
    cell.textContent = text
    Object.defineProperty(
        document.querySelector('[data-caramel-found="total"]'),
        'innerText',
        { value: `Total ${text}`, configurable: true },
    )
}
/** The store takes the code back, as neweracap.com did. */
function storeReverses() {
    orderTags('')
    totalReads('USD $38.99')
}

const answer = (fields = {}) => ({
    success: false,
    newTotal: NaN,
    committed: false,
    errorMsg: null,
    errorIsNew: false,
    ...fields,
})
/** The store applies the code: a tag and a $0.00 order. */
const appliesFree = () => {
    orderTags(tag('FREE'))
    totalReads('USD $0.00')
    return answer({ success: true, newTotal: 0 })
}
const silent = total => () => answer({ newTotal: total })
const EXISTING = "FREESHIP couldn't be used with your existing discounts."

async function elapse(ms) {
    for (let t = 0; t < ms; t += 100) {
        await vi.advanceTimersByTimeAsync(100)
        stubs.clock += 100
    }
}
const worked = () =>
    stubs.sent.filter(
        m => m?.action === 'reportOutcome' && m.outcome === 'worked',
    )
const boxSaves = () => stubs.sent.filter(m => m?.action === 'couponBoxSave')

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
            getURL: path => `chrome-extension://test/${path}`,
            sendMessage: (message, cb) => {
                stubs.sent.push(message)
                if (handoffs.answers(message, cb)) return
                cb?.({})
            },
        },
        storage: {
            local: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            sync: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            session: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
        },
    }
    initCaramelBase()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
    // The page has the finder loaded: the runner reads the total through it.
    _caramelUseLoadedFinder(finder)
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handoffs.reset()
    sessionStorage.clear()
    document.body.innerHTML =
        '<form><input data-caramel-found="input" placeholder="Discount code or gift card" />' +
        '<button data-caramel-found="submit">Apply</button></form>' +
        '<ul id="tags" role="list" aria-label="Discount code or gift card"></ul>' +
        '<div role="row" data-caramel-found="total">' +
        '<div role="rowheader"><strong>Total</strong></div>' +
        '<div role="cell"></div></div>'
    totalReads('USD $38.99')
    globalThis._caramelCancelled = false
    stubs.applied = []
    stubs.appliedAt = {}
    stubs.finalModalCalls = []
    stubs.shownAt = null
    stubs.sent = []
    stubs.savings = []
    stubs.codes = ['Free', 'Freeship']
    stubs.cart = null
    stubs.linkCarts = {}
    stubs.clock = 0
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — a credit waits for the store to settle (T-11366)', () => {
    it('(a) a code the store applies and then takes back is not a saving: no card, no "worked" report, no box save, and the next code is tried', async () => {
        stubs.answers = {
            Free: () => {
                const res = appliesFree()
                // neweracap.com took the tag away 5.6 s after applying it.
                setTimeout(storeReverses, 4200)
                return res
            },
            Freeship: silent(38.99),
        }

        startApplyingCoupons(rec())
        await elapse(60000)

        expect(stubs.applied).toEqual(['Free', 'Freeship'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(saved).toBe(0)
        expect(worked()).toEqual([])
        expect(boxSaves()).toEqual([])
        expect(stubs.savings).toEqual([])
    })

    it('(b) a code the store keeps is credited as before, and the report and box save go out only after the settle', async () => {
        stubs.answers = { Free: appliesFree, Freeship: silent(38.99) }

        startApplyingCoupons(rec())
        // Inside the settle window: nothing has been claimed yet.
        await elapse(3000)
        expect(stubs.applied).toEqual(['Free'])
        expect(stubs.finalModalCalls).toEqual([])
        expect(worked()).toEqual([])
        expect(boxSaves()).toEqual([])

        await elapse(60000)

        expect(stubs.applied).toEqual(['Free'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('Free')
        expect(saved).toBeCloseTo(38.99, 2)
        // The clock moves in 100 ms steps, so it can read one step short.
        expect(stubs.shownAt - stubs.appliedAt.Free).toBeGreaterThanOrEqual(
            CARAMEL_SETTLE_FULL_MS - 100,
        )
        expect(worked()).toEqual([
            expect.objectContaining({ id: 'c0', outcome: 'worked' }),
        ])
        expect(boxSaves()).toEqual([
            expect.objectContaining({ box: expect.objectContaining(BOX) }),
        ])
        expect(stubs.savings).toEqual([
            expect.objectContaining({ code: 'Free', couponId: 'c0' }),
        ])
    })

    it('(c) an ordinary drop that holds is credited after the short window, at the total the store settled on', async () => {
        stubs.codes = ['SAVE15', 'Freeship']
        stubs.answers = {
            SAVE15: () => {
                totalReads('USD $33.14')
                // The store redraws its summary with the tax recomputed.
                setTimeout(() => totalReads('USD $33.50'), 300)
                return answer({ success: true, newTotal: 33.14 })
            },
            Freeship: silent(38.99),
        }

        startApplyingCoupons(rec())
        await elapse(60000)

        expect(stubs.applied).toEqual(['SAVE15'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('SAVE15')
        expect(saved).toBeCloseTo(5.49, 2)
        expect(stubs.shownAt - stubs.appliedAt.SAVE15).toBeLessThanOrEqual(
            CARAMEL_SETTLE_SHORT_MS + 500,
        )
        expect(worked()).toEqual([
            expect.objectContaining({ id: 'c0', outcome: 'worked' }),
        ])
    })

    it('(d) a late-code credit the store then takes back is not credited', async () => {
        stubs.codes = ['5QD572J2', 'Free', 'Freeship']
        stubs.answers = {
            '5QD572J2': () =>
                answer({
                    newTotal: 38.99,
                    errorMsg: 'This discount has reached its usage limit',
                    errorIsNew: true,
                }),
            // Free's discount lands after its wait.
            Free: silent(NaN),
            Freeship: () => {
                orderTags(tag('FREE'))
                totalReads('USD $0.00')
                setTimeout(storeReverses, 3000)
                return answer({ errorMsg: EXISTING, errorIsNew: true })
            },
        }

        startApplyingCoupons(rec())
        await elapse(60000)

        expect(stubs.applied).toEqual(['5QD572J2', 'Free', 'Freeship'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(saved).toBe(0)
        expect(worked()).toEqual([])
        expect(boxSaves()).toEqual([])
        expect(stubs.savings).toEqual([])
    })

    it('(e) discount-link path: a code that makes the order free and is then dropped from the cart is not credited', async () => {
        stubs.codes = ['FREE']
        stubs.cart = cart(3899)
        stubs.linkCarts = {
            FREE: cart(0, [{ code: 'FREE', applicable: true, amount: 3899 }]),
        }
        // The store drops the code from the cart a few seconds later.
        setTimeout(() => {
            stubs.cart = cart(3899, [
                { code: 'FREE', applicable: false, amount: 0 },
            ])
        }, 4000)

        startApplyingCoupons({ domain: 'neweracap.com' })
        await elapse(60000)

        expect(await handoffs.peek('applied')).toBeNull()
        expect(worked()).toEqual([])
        const [saved, code, message] = stubs.finalModalCalls.at(-1)
        expect(saved).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/wouldn't keep it on your cart/)
    })
})
