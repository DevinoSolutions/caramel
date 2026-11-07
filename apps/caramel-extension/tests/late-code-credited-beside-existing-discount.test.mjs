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
import {
    caramelCodeOnOrder,
    caramelRefusedForExistingDiscount,
} from '../coupon-apply.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// A code that lands after its own wait, credited when the next code is refused
// for the discount it put on the order (T-10544).
//
// neweracap.com (2026-10-30): an earlier code took $38.99 off and the order
// read $0.00, FREESHIP was then refused "couldn't be used with your existing
// discounts", that drop was rightly not FREESHIP's, and the card said nothing
// worked. The earlier code is the win: the one the order names, else the last
// failed code that can still be on the order.

const handoffs = tabHandoffBackground()
const stubs = vi.hoisted(() => ({
    answers: {},
    applied: [],
    removed: [],
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
    removeAppliedCoupon: async (_rec, { code }) => {
        stubs.removed.push(code)
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
        caramelRecordSaving: entry => stubs.savings.push(entry),
    }
})
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: async () =>
        ['NEWERA25', 'TAKE10', 'FREESHIP'].map((code, i) => ({
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

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

/** What the store's total box reads now. */
function totalReads(text) {
    Object.defineProperty(document.getElementById('total'), 'innerText', {
        value: text,
        configurable: true,
    })
    document.getElementById('total').textContent = text
}
/** The store lists `code` among the discounts on the order (Shopify). */
function orderNames(code) {
    document.getElementById('reduction-tags').innerHTML =
        `<li id="reduction-tag-1">${code} ${code.toLowerCase()}</li>`
}
// The store said nothing in the window: the code's discount came later.
const silent = total => () => ({
    success: false,
    newTotal: total,
    committed: false,
    errorMsg: '',
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
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handoffs.reset()
    sessionStorage.clear()
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<ul id="reduction-tags"></ul><div id="total"></div>'
    totalReads('Total $38.99')
    globalThis._caramelCancelled = false
    stubs.applied = []
    stubs.removed = []
    stubs.finalModalCalls = []
    stubs.sent = []
    stubs.savings = []
})

afterEach(() => {
    vi.useRealTimers()
})

describe('coupon-runner.js — an earlier code that landed late (T-10544)', () => {
    it('credits the earlier code when the next is refused for existing discounts, and stops', async () => {
        stubs.answers = {
            NEWERA25: silent(38.99),
            // The first code's discount lands after its wait: the next code
            // sees the lower total beside its refusal.
            TAKE10: () => {
                totalReads('Total $29.24')
                return refusedWith(
                    "TAKE10 couldn't be used with your existing discounts.",
                    29.24,
                )()
            },
            FREESHIP: refusedWith(EXISTING, 29.24),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['NEWERA25', 'TAKE10'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('NEWERA25')
        expect(saved).toBeCloseTo(9.75, 2)
        expect(reports()).toEqual([
            expect.objectContaining({ id: 'c0', outcome: 'worked' }),
        ])
        expect(stubs.savings).toEqual([
            expect.objectContaining({ code: 'NEWERA25', couponId: 'c0' }),
        ])
        expect(stubs.savings[0].amount).toBeCloseTo(9.75, 2)
    })

    it('credits the code the order names, even when another was submitted after it, and a $0.00 total', async () => {
        stubs.answers = {
            // A transient error, then the code landed anyway: without the
            // order naming it, the last silent code (TAKE10) would be the guess.
            NEWERA25: refusedWith(
                'Something went wrong. Please try again.',
                38.99,
            ),
            TAKE10: silent(38.99),
            FREESHIP: () => {
                orderNames('NEWERA25')
                totalReads('Total $0.00')
                return refusedWith(EXISTING, 0)()
            },
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['NEWERA25', 'TAKE10', 'FREESHIP'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBe('NEWERA25')
        expect(saved).toBeCloseTo(38.99, 2)
        expect(reports()).toEqual([
            expect.objectContaining({ id: 'c0', outcome: 'worked' }),
        ])
    })

    it('credits nothing when the total is not below the starting total', async () => {
        stubs.answers = {
            NEWERA25: silent(38.99),
            TAKE10: refusedWith(
                "TAKE10 couldn't be used with your existing discounts.",
                38.99,
            ),
            FREESHIP: refusedWith(EXISTING, 38.99),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['NEWERA25', 'TAKE10', 'FREESHIP'])
        const [saved, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(saved).toBe(0)
        expect(stubs.savings).toEqual([])
    })

    it('credits nothing beside a plain "invalid code" refusal, whatever the total', async () => {
        stubs.answers = {
            NEWERA25: silent(38.99),
            TAKE10: () => {
                totalReads('Total $29.24')
                return refusedWith('TAKE10 is not a valid code.', 29.24)()
            },
            FREESHIP: refusedWith('FREESHIP is not a valid code.', 29.24),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        expect(stubs.applied).toEqual(['NEWERA25', 'TAKE10', 'FREESHIP'])
        const [, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
        expect(reports().some(m => m.outcome === 'worked')).toBe(false)
    })

    it('credits nothing when the only earlier code was refused in the store’s words', async () => {
        stubs.answers = {
            NEWERA25: refusedWith('NEWERA25 is not a valid code.', 38.99),
            TAKE10: () => {
                totalReads('Total $29.24')
                return refusedWith(
                    "TAKE10 couldn't be used with your existing discounts.",
                    29.24,
                )()
            },
            FREESHIP: refusedWith(EXISTING, 29.24),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        const [, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
    })

    it('credits nothing on the first code: there is no earlier code to credit', async () => {
        stubs.answers = {
            NEWERA25: () => {
                totalReads('Total $29.24')
                return refusedWith(
                    "NEWERA25 couldn't be used with your existing discounts.",
                    29.24,
                )()
            },
            TAKE10: refusedWith('TAKE10 is not a valid code.', 29.24),
            FREESHIP: refusedWith('FREESHIP is not a valid code.', 29.24),
        }

        startApplyingCoupons(REC)
        await elapse(60000)

        const [, code] = stubs.finalModalCalls.at(-1)
        expect(code).toBeNull()
    })
})

describe('caramelRefusedForExistingDiscount — the store refusing over a discount on the order', () => {
    it.each([
        "FREESHIP couldn't be used with your existing discounts.",
        'This code cannot be combined with other offers.',
        "Discount codes can't be combined.",
        'A discount code has already been applied to your order.',
        'Your cart already has a discount applied.',
        'This promo code is not valid with other discounts.',
        'Only one discount code per order.',
        'Coupons cannot be stacked.',
        'Dieser Gutschein ist nicht mit anderen Rabatten kombinierbar.',
        "Ce code n'est pas cumulable avec d'autres réductions.",
        'Este cupón no se puede combinar con otros descuentos.',
        'Codice non cumulabile con altri sconti.',
        'Deze code is niet te combineren met andere kortingen.',
    ])('reads %j as that refusal', text => {
        expect(caramelRefusedForExistingDiscount(text)).toBe(true)
    })

    it.each([
        'Enter a valid discount code',
        'FREESHIP is not a valid code.',
        'This code has expired.',
        'This code has already been used.',
        'This code was already applied to another order.',
        // An acceptance with a caveat is the code working, not a refusal.
        'Promo code applied. Cannot be combined with other offers.',
        // A refusal that also calls the code invalid is a plain refusal.
        'Invalid code. Cannot be combined with other offers.',
        'Please try another code.',
        'Please try other codes.',
        'Minimum spend $50 for this code.',
        '',
    ])('does not read %j as that refusal', text => {
        expect(caramelRefusedForExistingDiscount(text)).toBe(false)
    })
})

describe('caramelCodeOnOrder — the code the order shows as applied', () => {
    it('matches a Shopify reduction tag word exactly, in any case', () => {
        orderNames('NEWERA25')
        expect(caramelCodeOnOrder(REC, ['newera25', 'TAKE10'])).toBe('newera25')
    })

    it('does not match part of a word', () => {
        orderNames('NEWERA250')
        expect(caramelCodeOnOrder(REC, ['NEWERA25'])).toBeNull()
    })

    it('prefers the most recent code when the order names several', () => {
        document.getElementById('reduction-tags').innerHTML =
            '<li>NEWERA25</li><li>TAKE10</li>'
        expect(caramelCodeOnOrder(REC, ['NEWERA25', 'TAKE10'])).toBe('TAKE10')
    })

    it('ignores a row that says the code was not applied', () => {
        document.getElementById('reduction-tags').innerHTML =
            '<li>NEWERA25 not applied</li>'
        expect(caramelCodeOnOrder(REC, ['NEWERA25'])).toBeNull()
    })

    it('reads the config’s own applied rows too', () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="applied-code">Code TAKE10 (-$5.00)</div>',
        )
        expect(
            caramelCodeOnOrder({ ...REC, successIndicator: '.applied-code' }, [
                'TAKE10',
            ]),
        ).toBe('TAKE10')
    })
})
