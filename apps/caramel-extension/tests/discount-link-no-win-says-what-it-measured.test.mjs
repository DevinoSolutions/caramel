import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
const handoffs = tabHandoffBackground()

// When no code on the discount-link path beats the cart, the card used to say
// "Auto-apply didn't stick this time", which blames the tool. On the stores
// where this lands, the store's own cart marked every code we sent not
// applicable. The card may say "none lowered your total" only when we read the
// total back after EVERY code; with any total unread, or a total that fell only
// because the cart emptied, it keeps the default line.

const stubs = vi.hoisted(() => ({
    applyViaDiscountLink: null,
    probeCartJson: null,
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
// See discount-link-empty-cart-is-no-saving.test.mjs: the list is fed through
// store-detect's cache so the real ranking path runs.
vi.mock('../store-detect.js', async importOriginal => ({
    ...(await importOriginal()),
    getCachedCodes: (...args) => stubs.getCoupons(...args),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let carts

const REC = { domain: 'bostonproper.com' }
const BASE = 6500

function cart(total, { items = 1, codes = [] } = {}) {
    return {
        token: 't',
        total_price: total,
        item_count: items,
        discount_codes: codes,
        currency: 'USD',
    }
}

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            sendMessage: (msg, cb) => {
                handoffs.answers(msg, cb)
            },
        },
    }
    initCaramelBase()
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(() => {
    handoffs.reset()
    document.body.innerHTML = ''
    sessionStorage.clear()
    stubs.finalModalCalls = []
    carts = {}
    globalThis._caramelCancelled = false
    let held = cart(BASE)
    stubs.probeCartJson = async () => held
    stubs.applyViaDiscountLink = async code => {
        const after = carts[code] ?? null
        if (after) held = after
        return after
    }
    stubs.getCoupons = async () => [
        { code: 'FALL20', id: 'c1' },
        { code: 'WELCOME10', id: 'c2' },
    ]
})

const finalMessage = () => stubs.finalModalCalls.at(-1)[2]

describe('the no-win card on the discount-link path', () => {
    it('says none lowered the total when every total was read back', async () => {
        // The store's own answer: the code is attached but not applicable.
        const notApplicable = code =>
            cart(BASE, { codes: [{ code, applicable: false, amount: 0 }] })
        carts = {
            FALL20: notApplicable('FALL20'),
            WELCOME10: notApplicable('WELCOME10'),
        }

        await startApplyingCoupons(REC)

        expect(finalMessage()).toBe(
            'We tried 2 codes on your cart and none lowered your total. You can still paste one by hand.',
        )
    })

    it('keeps the default line when a total could not be read', async () => {
        // WELCOME10's probe returned nothing: we never saw its total.
        carts = { FALL20: cart(BASE) }

        await startApplyingCoupons(REC)

        expect(finalMessage()).toBeNull()
    })

    it('keeps the default line when a total fell only because the cart emptied', async () => {
        carts = { FALL20: cart(BASE), WELCOME10: cart(0, { items: 0 }) }

        await startApplyingCoupons(REC)

        expect(finalMessage()).toBeNull()
    })
})
