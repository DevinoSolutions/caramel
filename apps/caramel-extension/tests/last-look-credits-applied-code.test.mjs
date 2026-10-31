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

// The card said "Auto-apply didn't stick this time" while a code it tried was
// still applied and saving the shopper money (T-11601, 1.4.30 and 1.4.31,
// 2026-10-31). Two stores, two reasons:
//
// (A) gant.co.uk, SFCC, no config: the finder found the box but no total.
//     GB14 applied, the box folded away behind "GB14 - As a subscriber ...
//     Remove" and the order showed -£10. The attempt read nothing, and the run
//     typed six more codes into a box that was gone, then ended with "none".
// (B) store.franklinplanner.com, BigCommerce, configured: FPBDAY took GRAND
//     TOTAL $17.95 to $14.36 after its attempt was judged; the time budget
//     ended the run before anything looked again.
//
// The markup below is modelled on both checkouts.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    answers: {},
    applied: [],
    finalModalCalls: [],
    sent: [],
    savings: [],
    codes: [],
    clock: 0,
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
        stubs.codes.map((code, i) => ({ code, id: `c${i}` })),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

const answer = (fields = {}) => ({
    success: false,
    newTotal: NaN,
    committed: false,
    errorMsg: null,
    errorIsNew: false,
    ...fields,
})
/** An attempt that takes `ms` of the store's time before it is judged. */
const after = (ms, fields, then) => () =>
    new Promise(resolve =>
        setTimeout(() => {
            then?.()
            resolve(answer(typeof fields === 'function' ? fields() : fields))
        }, ms),
    )

// The runner's time budget reads performance.now(), moved here with the timers.
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

/* ------------------------------------------------ (A) the SFCC cart page */

const BOX = { input: '#couponCode', apply: '#apply-coupon', total: '#total' }
const gantRec = () => ({
    domain: 'www.gant.co.uk',
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
    caramelNoConfig: true,
    caramelSave: { ...BOX },
})
const GANT_PAGE =
    '<div class="product-line-item" data-cart-itemid="1">Knitted Silk Tie' +
    ' <select name="quantity"><option>1</option></select>' +
    ' <a href="#" class="remove-product">Remove</a></div>' +
    '<div class="order-summary"><p>Order value £100</p>' +
    '<p id="adjustments"></p></div>' +
    '<div id="coupon-area"><button aria-expanded="false">+ Enter promotional code</button>' +
    '<form id="coupon-form"><input id="couponCode" data-caramel-found="input" />' +
    '<button id="apply-coupon" data-caramel-found="submit">Apply</button></form>' +
    '<div id="applied"></div></div>'

/** The store applies GB14: the box folds away behind the applied code. */
function gantApplies() {
    document.getElementById('coupon-form').hidden = true
    document.getElementById('adjustments').textContent =
        "As a subscriber to GANT's newsletter, we now offer you 10% on an entire purchase. - £10"
    document.getElementById('applied').innerHTML =
        '<div class="coupon-price-adjustment"><span class="coupon-code">GB14</span>' +
        " - As a subscriber to GANT's newsletter, we now offer you 10% on an" +
        ' entire purchase. The discount is valid for 90 days and can not be' +
        ' combined with other offers or sale.' +
        ' <button type="button" class="remove-coupon">Remove</button></div>'
}

/* ------------------------------------------- (B) the BigCommerce checkout */

const franklinRec = () => ({
    domain: 'store.franklinplanner.com',
    couponInput: '#redeemableCode',
    couponSubmit: '#applyRedeemableButton',
    priceContainer: '#grand-total',
    errorIndicator: null,
    successIndicator: null,
    couponRemove: null,
})
const FRANKLIN_PAGE =
    '<form><input id="redeemableCode" /><button id="applyRedeemableButton">Apply</button></form>' +
    '<section class="cart-section"><div data-test="cart-subtotal">Subtotal (USD) $17.95</div>' +
    '<div id="coupons"></div>' +
    '<div data-test="cart-total" id="grand-total"></div></section>'

function grandTotalReads(text) {
    const el = document.getElementById('grand-total')
    el.textContent = text
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}
// What the attempt reads off the GRAND TOTAL when it is judged.
const reads = () => ({
    newTotal: Number(
        document.getElementById('grand-total').textContent.split('$')[1],
    ),
})
/** BigCommerce's coupon row; `withCode` false leaves the code unprinted. */
function franklinApplies(code, withCode = true) {
    document.getElementById('coupons').innerHTML =
        '<div class="cart-priceItem" data-test="cart-coupon">' +
        '<span class="cart-priceItem-label">Save 20% off your entire order' +
        ' <a href="#" class="cart-priceItem-link">Remove</a></span>' +
        '<span class="cart-priceItem-value">-$3.59</span>' +
        (withCode
            ? `<span class="cart-priceItem-postFix">${code}</span>`
            : '') +
        '</div>'
    grandTotalReads('GRAND TOTAL (USD) $14.36')
}
function franklinReverses() {
    document.getElementById('coupons').innerHTML = ''
    grandTotalReads('GRAND TOTAL (USD) $17.95')
}
/** The run as the 1.4.31 log shows it: 22132 silent, SAVE10 accepted for
 * $0.00, FPBDAY judged at $17.95 and landing a beat later, then the time
 * budget. `lands` is what the store does after FPBDAY was judged. */
function franklinRun(lands) {
    stubs.codes = ['22132', 'SAVE10', 'FPBDAY', 'TREAT', 'QUALITY10']
    stubs.answers = {
        22132: after(10000, reads),
        SAVE10: after(6000, {
            success: true,
            newTotal: 17.95,
            committed: true,
        }),
        FPBDAY: after(18000, reads, () => setTimeout(lands, 600)),
        TREAT: after(5000, reads),
        QUALITY10: after(5000, reads),
    }
}

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
    // Shown unless the fixture hides it (jsdom lays nothing out).
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = function () {
        return !this.closest('[hidden]')
    }
    _caramelUseLoadedFinder(finder)
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubs.clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => stubs.clock)
    handoffs.reset()
    sessionStorage.clear()
    globalThis._caramelCancelled = false
    stubs.applied = []
    stubs.finalModalCalls = []
    stubs.sent = []
    stubs.savings = []
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('coupon-runner.js — a code the order shows applied is never "didn\'t stick" (T-11601)', () => {
    it('(A) no readable total: the code the order names stops the run, and the card says it is applied with no amount', async () => {
        document.body.innerHTML = GANT_PAGE
        stubs.codes = ['GB14', 'GB03A', 'GB01', 'GB10', 'GB06', '5off']
        stubs.answers = Object.fromEntries(
            stubs.codes.map(c => [c, after(4700, {})]),
        )
        stubs.answers.GB14 = after(5200, {}, gantApplies)

        startApplyingCoupons(gantRec())
        await elapse(90000)

        expect(stubs.applied).toEqual(['GB14'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('GB14')
        expect(saved).toBe(0)
        // Applied, with no amount we did not read: nothing banked.
        expect(stubs.savings).toEqual([])
        expect(worked()).toEqual([
            expect.objectContaining({ id: 'c0', outcome: 'worked' }),
        ])
        expect(boxSaves()).toEqual([
            expect.objectContaining({ box: expect.objectContaining(BOX) }),
        ])
    })

    it('(A) the code only sitting in the promo box is not applied: every code is tried and nothing is credited', async () => {
        document.body.innerHTML = GANT_PAGE
        stubs.codes = ['GB14', 'GB03A', 'GB01']
        stubs.answers = Object.fromEntries(
            stubs.codes.map(c => [
                c,
                after(4700, {}, () => {
                    document.getElementById('couponCode').value = c
                }),
            ]),
        )

        startApplyingCoupons(gantRec())
        await elapse(90000)

        expect(stubs.applied).toEqual(['GB14', 'GB03A', 'GB01'])
        expect(stubs.finalModalCalls.at(-1)[1]).toBeNull()
        expect(worked()).toEqual([])
    })

    it("(A) the code inside the store's refusal is not applied, even beside a remove button", async () => {
        document.body.innerHTML = GANT_PAGE
        stubs.codes = ['GB14', 'GB03A', 'GB01']
        stubs.answers = Object.fromEntries(
            stubs.codes.map(c => [c, after(4700, {})]),
        )
        stubs.answers.GB14 = after(4700, {}, () => {
            document.getElementById('applied').innerHTML =
                '<div class="coupon-row"><span>GB14</span> is not valid for this order.' +
                ' <button class="remove-coupon">Remove</button></div>'
        })

        startApplyingCoupons(gantRec())
        await elapse(90000)

        expect(stubs.applied).toEqual(['GB14', 'GB03A', 'GB01'])
        expect(stubs.finalModalCalls.at(-1)[1]).toBeNull()
        expect(worked()).toEqual([])
    })

    it('(B) a code that lands after it was judged, then the time budget: the last look credits the code the order names, with the saving read off the total', async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        franklinRun(() => franklinApplies('FPBDAY'))

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        expect(stubs.applied).toEqual(['22132', 'SAVE10', 'FPBDAY'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('FPBDAY')
        expect(saved).toBeCloseTo(3.59, 2)
        expect(worked()).toEqual([
            expect.objectContaining({ id: 'c2', outcome: 'worked' }),
        ])
        expect(stubs.savings).toEqual([
            expect.objectContaining({ code: 'FPBDAY', couponId: 'c2' }),
        ])
    })

    it("(B) the order does not print the code: the drop after the last code's own wait is that code's", async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        franklinRun(() => franklinApplies('FPBDAY', false))

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('FPBDAY')
        expect(saved).toBeCloseTo(3.59, 2)
    })

    it('(B) a late code the store then takes back is not credited (T-11366)', async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        franklinRun(() => {
            franklinApplies('FPBDAY')
            // Inside the settle window, after the last look's two reads.
            setTimeout(franklinReverses, 1800)
        })

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(saved).toBe(0)
        expect(worked()).toEqual([])
        expect(stubs.savings).toEqual([])
    })

    it('(B) an order that drops to $0.00 without naming a code is not a saving', async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        franklinRun(() => grandTotalReads('GRAND TOTAL (USD) $0.00'))

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        expect(stubs.finalModalCalls.at(-1)[1]).toBeNull()
        expect(worked()).toEqual([])
    })

    it('(B) a code the store took for $0.00 is never the cause of a later drop, even where the order prints it', async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        // The order prints the flat code; the drop came after FPBDAY.
        franklinRun(() => franklinApplies('SAVE10'))

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        expect(stubs.finalModalCalls.at(-1)[1]).toBe('FPBDAY')
    })

    it("(B) a drop beside the last code's refusal credits nothing", async () => {
        document.body.innerHTML = FRANKLIN_PAGE
        grandTotalReads('GRAND TOTAL (USD) $17.95')
        franklinRun(() => {})
        stubs.answers.FPBDAY = after(
            18000,
            {
                newTotal: 17.95,
                errorMsg: 'FPBDAY is not a valid code.',
                errorIsNew: true,
            },
            () => setTimeout(() => franklinApplies('FPBDAY', false), 600),
        )

        startApplyingCoupons(franklinRec())
        await elapse(120000)

        expect(stubs.finalModalCalls.at(-1)[1]).toBeNull()
        expect(worked()).toEqual([])
    })
})

const rec = { couponInput: '#promo' }
/** A page whose promo box holds GB14, with `html` beside it. */
function page(html) {
    document.body.innerHTML =
        '<form><input id="promo" value="GB14" /><button>Apply</button></form>' +
        html
}

describe('caramelCodeOnOrder — an applied code beyond Shopify (T-11601)', () => {
    it('reads a code in a row with its own remove control', () => {
        page(
            '<div><span>GB14</span> - 10% off your order <button>Remove</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBe('GB14')
    })

    it('reads a code in a discount row with a negative amount', () => {
        page(
            '<div><span>Coupon discount (FPBDAY)</span><span>-$3.59</span></div>',
        )
        expect(caramelCodeOnOrder(rec, ['FPBDAY'])).toBe('FPBDAY')
    })

    it('reads a bare × only when its markup says it removes the code', () => {
        page(
            '<div><span>CHEERS25</span><button class="remove-coupon">×</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['CHEERS25'])).toBe('CHEERS25')
        page('<div>Use code CHEERS25 at checkout <button>×</button></div>')
        expect(caramelCodeOnOrder(rec, ['CHEERS25'])).toBeNull()
    })

    it('does not read the code sitting in the promo box', () => {
        page('')
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
    })

    it('does not read a refusal that names the code, beside a remove control or not', () => {
        page(
            '<div><span>GB14</span> is not valid. <button>Remove</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
        page(
            '<div role="alert">GB14 cannot be combined with other offers -$10 <button aria-label="Remove">×</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
        page(
            '<div class="coupon-row">GB14 NOT APPLIED <button class="remove-coupon">×</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
    })

    it('does not read a product line that carries the word', () => {
        page(
            '<div class="cart-item">BEST seller planner <select name="quantity"></select>' +
                ' <button>Remove</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['BEST'])).toBeNull()
    })

    it('does not read a gift card, nor a close button', () => {
        page(
            '<div>Gift card GB14 -$10 <button>Remove</button></div>' +
                '<div>Use GB14 for 10% off <button aria-label="Close">Remove</button></div>',
        )
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
    })

    it('does not read our own UI', () => {
        page('')
        const host = document.createElement('div')
        host.id = 'caramel-final-overlay'
        host.attachShadow({ mode: 'open' }).innerHTML =
            '<div>GB14 is applied -£10 <button>Remove</button></div>'
        document.body.appendChild(host)
        const light = document.createElement('div')
        light.id = 'caramel-testing-overlay'
        light.innerHTML = '<div>GB14 -£10 <button>Remove</button></div>'
        document.body.appendChild(light)
        expect(caramelCodeOnOrder(rec, ['GB14'])).toBeNull()
    })
})
