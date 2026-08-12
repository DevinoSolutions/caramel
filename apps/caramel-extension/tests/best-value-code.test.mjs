import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { caramelEstimatedValue, caramelRankByValue } from '../coupon-fetch.js'
import { startApplyingCoupons } from '../coupon-runner.js'

// The pill says "the best code". It was taking the first one.
//
// personalabs.com (QA sweep 2026-08-06): a $135 cart, our own list holding both
// TREAT22 and flash35. The loop stopped at TREAT22 for $1.35, banked it, and
// showed "Savings Found". flash35 — the very next entry, never attempted —
// took $47.25 when pasted by hand seconds later on the identical cart. We left
// $45.90 on a cart we had already "succeeded" on, using a code we already held.
//
// Two things had to change, and the metadata is why they are separate:
//
// 1. ORDER — the API gives every coupon a discount_type/discount_amount that
//    nothing read. Now they pick who goes first.
// 2. OUTCOME — that metadata LIES (TREAT22 advertised 30% and delivered 1%), so
//    the order is only a hint. The winner is decided by the cart's real total,
//    measured after every probe, and the winner is re-applied at the end.
//
// Affordable only on the discount-link path, where a probe is one ~0.5s request
// and the answer is the live total. The DOM path still stops at its first win.

// Collaborators the old suite replaced by assigning over a global are replaced
// through module mocks now; a factory forwards to a per-test slot so a
// beforeEach — or a test that swaps one mid-file — still reads as one
// assignment.
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

const REC = { domain: 'personalabs.com' }

const BASE = 13500

function cart(total, codes = []) {
    return {
        token: 't',
        total_price: total,
        item_count: 2,
        discount_codes: codes,
        currency: 'USD',
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
            sendMessage: msg => {
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
    document.body.innerHTML = ''
    sessionStorage.clear()
    linkCalls = []
    finalModalCalls = stubs.finalModalCalls = []
    outcomeCalls = []
    // What each code is really worth, independent of what its metadata claims.
    carts = {
        TREAT22: cart(BASE - 135),
        FLASH35: cart(BASE - 4725),
        DEADCODE: cart(BASE),
    }
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
        {
            code: 'TREAT22',
            id: 'c1',
            discount_type: 'PERCENTAGE',
            discount_amount: 30,
        },
        {
            code: 'FLASH35',
            id: 'c2',
            discount_type: 'PERCENTAGE',
            discount_amount: 5,
        },
    ]
})

const applied = () =>
    JSON.parse(sessionStorage.getItem('caramel_applied') || 'null')

describe('what a coupon is plausibly worth', () => {
    it('scales a percentage against the cart', () => {
        expect(
            caramelEstimatedValue(
                { discount_type: 'PERCENTAGE', discount_amount: 35 },
                10000,
            ),
        ).toBe(3500)
    })

    it('reads a cash amount in the cart’s own minor units', () => {
        expect(
            caramelEstimatedValue(
                { discount_type: 'CASH', discount_amount: 20 },
                10000,
            ),
        ).toBe(2000)
    })

    it('cannot take off more than the cart holds', () => {
        // "$150 off" codes are all over the catalogue (hexclad); on a $30 cart
        // that is $30, not $150, and must not outrank a real 50%.
        expect(
            caramelEstimatedValue(
                { discount_type: 'CASH', discount_amount: 150 },
                3000,
            ),
        ).toBe(3000)
        expect(
            caramelEstimatedValue(
                { discount_type: 'PERCENTAGE', discount_amount: 300 },
                10000,
            ),
        ).toBe(10000)
    })

    it('rates an unpriced coupon zero rather than guessing', () => {
        expect(caramelEstimatedValue({ code: 'FREESHIP' }, 10000)).toBe(0)
        expect(
            caramelEstimatedValue(
                { discount_type: 'CASH', discount_amount: -5 },
                10000,
            ),
        ).toBe(0)
        expect(caramelEstimatedValue(null, 10000)).toBe(0)
    })
})

describe('best-first ordering', () => {
    it('puts the bigger advertised discount first', () => {
        const ranked = caramelRankByValue(
            [
                {
                    code: 'SMALL',
                    discount_type: 'PERCENTAGE',
                    discount_amount: 5,
                },
                {
                    code: 'BIG',
                    discount_type: 'PERCENTAGE',
                    discount_amount: 35,
                },
            ],
            10000,
        )

        expect(ranked.map(c => c.code)).toEqual(['BIG', 'SMALL'])
    })

    it('keeps unvalued codes in the order they arrived', () => {
        // Unknown is not worthless — a free-shipping code with no amount may be
        // the only thing that works, so it must not be shuffled at random.
        const ranked = caramelRankByValue(
            [{ code: 'A' }, { code: 'B' }, { code: 'C' }],
            10000,
        )

        expect(ranked.map(c => c.code)).toEqual(['A', 'B', 'C'])
    })

    it('survives a missing or ragged list', () => {
        expect(caramelRankByValue(null, 10000)).toEqual([])
        expect(
            caramelRankByValue([{ code: 'A' }], NaN).map(c => c.code),
        ).toEqual(['A'])
    })
})

describe('the winner is the best measured total, not the first that moves', () => {
    it('keeps looking after a code that already saved something', async () => {
        await startApplyingCoupons(REC)

        // The personalabs shape: TREAT22 goes first (it advertises 30%) and
        // wins $1.35. The old loop stopped right there.
        expect(linkCalls.slice(0, 2)).toEqual(['TREAT22', 'FLASH35'])
    })

    it('banks the bigger saving', async () => {
        await startApplyingCoupons(REC)

        expect(applied().code).toBe('FLASH35')
        expect(applied().saved).toBeCloseTo(47.25, 2)
    })

    it('leaves the winning code on the cart, not the last one probed', async () => {
        await startApplyingCoupons(REC)

        expect(linkCalls[linkCalls.length - 1]).toBe('FLASH35')
    })

    it('credits the code that actually worked', async () => {
        await startApplyingCoupons(REC)

        expect(outcomeCalls).toEqual([['c2', 'worked']])
    })

    it('still banks a lone winner', async () => {
        // Guards the guard: shopping around must not lose the single win.
        stubs.getCoupons = async () => [
            { code: 'DEADCODE', id: 'c0' },
            { code: 'TREAT22', id: 'c1' },
        ]

        await startApplyingCoupons(REC)

        expect(applied().code).toBe('TREAT22')
        expect(applied().saved).toBeCloseTo(1.35, 2)
    })
})

describe('what we report is what ended up on the cart', () => {
    // Shopping around introduced this risk and has to carry it. The winner is
    // put back with one more request, and that request can fail — a rate limit,
    // a code the store accepts only once, an expiry landing mid-run. Announcing
    // `bestTotal` regardless would report a saving that is no longer there: the
    // same false claim the measured-total rule exists to prevent, walked back in
    // through the fix for a different problem.
    const reapplyReturns = result => {
        let seen = 0
        stubs.applyViaDiscountLink = async code => {
            linkCalls.push(code)
            // Two probes, then the re-apply.
            if (++seen > 2) return result
            return carts[code] ?? null
        }
    }

    it('claims no win when the winner would not go back on', async () => {
        reapplyReturns(null)

        await startApplyingCoupons(REC)

        expect(applied()).toBeNull()
        expect(outcomeCalls).toEqual([])
    })

    it('hands the codes over instead of leaving a dead end', async () => {
        reapplyReturns(null)

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][0]).toBe(0)
        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it('leads with the code it watched work, not buries it', async () => {
        // Every probed code is marked tried, and the sink puts tried codes
        // last — so without this the single PROVEN code would be the hardest
        // one on the card to find.
        reapplyReturns(null)

        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][4][0].code).toBe('FLASH35')
    })

    it('says what happened to it, and what it was worth', async () => {
        reapplyReturns(null)

        await startApplyingCoupons(REC)

        const message = finalModalCalls[0][2]
        expect(message).toMatch(/FLASH35/)
        expect(message).toMatch(/47\.25/)
        expect(message).toMatch(/wouldn’t keep it|wouldn't keep it/)
    })

    it('claims no win when the code lands but saves nothing', async () => {
        reapplyReturns(cart(BASE))

        await startApplyingCoupons(REC)

        expect(applied()).toBeNull()
    })

    it('reports the smaller amount when the re-apply lands for less', async () => {
        // The cart is the authority, not the probe that came before it.
        reapplyReturns(cart(BASE - 1000))

        await startApplyingCoupons(REC)

        expect(applied().code).toBe('FLASH35')
        expect(applied().saved).toBeCloseTo(10, 2)
    })
})

describe('a discount the shopper arrived with is never left off the cart', () => {
    // They walked in with MEMBER50 already applied and worth more than anything
    // we hold. Probing replaces it — so it has to come back.
    //
    // The cart below is STATEFUL, which it was not before. The old fixture
    // answered every read with "MEMBER50 is applied" no matter what had been
    // sent, so it could not tell a probe that displaced their code from one
    // that didn't, and the tests underneath had to settle for asserting that a
    // re-apply REQUEST was made. On harney.com (2026-08-06) that request was
    // measured destroying the very discount it was meant to protect — the
    // endpoint appends, and re-sending a code the cart already holds demotes it
    // and kills it. A fixture that cannot express "their code is still on the
    // cart" cannot catch that, so this one tracks what is actually applied.
    let onCart

    const theirs = () =>
        cart(BASE - 6000, [
            { code: 'MEMBER50', amount: 6000, applicable: true },
        ])
    const displaced = () =>
        cart(BASE, [{ code: 'MEMBER50', amount: 6000, applicable: false }])

    beforeEach(() => {
        onCart = 'MEMBER50'
        stubs.probeCartJson = async () =>
            onCart === 'MEMBER50' ? theirs() : displaced()
        stubs.applyViaDiscountLink = async code => {
            linkCalls.push(code)
            onCart = code
            return code === 'MEMBER50' ? theirs() : (carts[code] ?? null)
        }
        stubs.getCoupons = async () => [
            { code: 'TREAT22', id: 'c1' },
            { code: 'DEADCODE', id: 'c2' },
        ]
    })

    it('leaves a surviving code alone instead of re-sending it', async () => {
        // harney.com: all eight probes failed and never displaced their code,
        // so there was nothing to restore — and the restore is what took the
        // $10.00 off them.
        stubs.applyViaDiscountLink = async code => {
            linkCalls.push(code)
            return carts[code] ?? null // these probes displace nothing
        }

        await startApplyingCoupons(REC)

        expect(linkCalls).not.toContain('MEMBER50')
    })

    it('puts their code back when nothing beat it', async () => {
        await startApplyingCoupons(REC)

        expect(linkCalls).toEqual(['TREAT22', 'DEADCODE', 'MEMBER50'])
    })

    it('puts their code back when the shopper cancels mid-run', async () => {
        let shown = 0
        stubs.updateTestingModal = async () => {
            if (++shown === 1) globalThis._caramelCancelled = true
        }

        await startApplyingCoupons(REC)

        expect(linkCalls).toEqual(['TREAT22', 'MEMBER50'])
    })

    it('says their code is the one still working', async () => {
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2]).toMatch(/MEMBER50 is already applied/)
    })
})
