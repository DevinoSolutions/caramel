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
import { caramelCodeOnOrder } from '../coupon-apply.js'
import { _caramelUseLoadedFinder } from '../coupon-box-finder-loader.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import * as finder from './_finder-under-test.mjs'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// The late-code credit (T-10544) on Shopify's current checkout, where the
// order names its codes in tag groups rather than #reduction-tags.
//
// neweracap.com (1.4.28, 2026-10-30): the box finder picked the form, Free
// took the whole $38.99 off after its own wait (order total $0.00, a "FREE"
// tag), FREESHIP was then refused "couldn't be used with your existing
// discounts", and the run still ended with nothing applied: a $0.00 total is
// credited only when the order names the code, and the tag was not read. The
// markup below is the live page's, with its generated class names dropped.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    answers: {},
    applied: [],
    finalModalCalls: [],
    sent: [],
    savings: [],
}))

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async code => {
        stubs.applied.push(code)
        return stubs.answers[code]()
    },
    removeAppliedCoupon: async () => {},
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
        caramelRecordSaving: entry => stubs.savings.push(entry),
    }
})
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        ['5QD572J2', 'Free', 'Freeship'].map((code, i) => ({
            code,
            id: `c${i}`,
        })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

// The record the box finder builds (coupon-box-discovery.js finderRecord).
const REC = {
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
}

/** Shopify's tag for an applied code, as neweracap.com drew it. */
const tag = (code, event = 'remove_discount_code') =>
    `<li><div id="tag-0" role="group"><div><div><div>` +
    `<span><svg aria-hidden="true"></svg></span>` +
    `<span><span aria-hidden="true" dir="auto"><span>${code}</span></span></span>` +
    `</div><span dir="auto">${code}</span></div></div>` +
    `<button aria-label="Remove ${code}" data-event-name="${event}" type="button">` +
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

const silent = total => () => ({
    success: false,
    newTotal: total,
    committed: false,
    errorMsg: null,
    errorIsNew: false,
})
const refusedWith = (errorMsg, total) => () => ({
    success: false,
    newTotal: total,
    committed: false,
    errorMsg,
    errorIsNew: true,
})
const EXISTING = "FREESHIP couldn't be used with your existing discounts."

async function elapse(ms) {
    for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100)
}
const reports = () => stubs.sent.filter(m => m?.action === 'reportOutcome')

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
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
    stubs.finalModalCalls = []
    stubs.sent = []
    stubs.savings = []
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — a late code named by a Shopify discount tag (T-10544)', () => {
    it('credits the code the tag names when the order reads $0.00 on a finder store', async () => {
        stubs.answers = {
            '5QD572J2': refusedWith(
                'This discount has reached its usage limit',
                38.99,
            ),
            // Free's discount lands after its wait; the read in its window
            // found no total it could trust.
            Free: silent(NaN),
            Freeship: () => {
                orderTags(tag('FREE'))
                totalReads('USD $0.00')
                return refusedWith(EXISTING, NaN)()
            },
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['5QD572J2', 'Free', 'Freeship'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('Free')
        expect(saved).toBeCloseTo(38.99, 2)
        expect(reports()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'c1', outcome: 'worked' }),
            ]),
        )
        expect(stubs.savings).toEqual([
            expect.objectContaining({ code: 'Free', couponId: 'c1' }),
        ])
    })

    it('credits nothing at $0.00 when no tag names a tried code', async () => {
        stubs.answers = {
            '5QD572J2': refusedWith(
                'This discount has reached its usage limit',
                38.99,
            ),
            Free: silent(NaN),
            Freeship: () => {
                // A code the shopper or the store put on, not one we tried.
                orderTags(tag('STAFF100'))
                totalReads('USD $0.00')
                return refusedWith(EXISTING, NaN)()
            },
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(saved).toBe(0)
        expect(stubs.savings).toEqual([])
    })
})

describe('caramelCodeOnOrder — Shopify discount tags', () => {
    it('reads the code from a discount tag group', () => {
        orderTags(tag('FREE'))
        expect(caramelCodeOnOrder(REC, ['5QD572J2', 'Free'])).toBe('Free')
    })

    it('reads it from the tag text alone, as a browser lays it out', () => {
        orderTags(tag('FREE'))
        const group = document.getElementById('tag-0')
        group.querySelector('button').removeAttribute('aria-label')
        Object.defineProperty(group, 'innerText', {
            value: 'FREE\nFREE',
            configurable: true,
        })
        expect(caramelCodeOnOrder(REC, ['Free'])).toBe('Free')
    })

    it('does not read a gift card tag as a code on the order', () => {
        orderTags(tag('FREE', 'remove_gift_card'))
        expect(caramelCodeOnOrder(REC, ['Free'])).toBeNull()
    })

    it('does not match part of a word', () => {
        orderTags(tag('FREESHIP'))
        expect(caramelCodeOnOrder(REC, ['Free'])).toBeNull()
    })
})
