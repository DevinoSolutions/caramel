import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// A store we hold codes for, that nobody has written a config for.
//
// Sampled against the live catalogue on 2026-08-06: 573 stores with coupons,
// 209 of them (36%) with no row in the supported-stores list. The popup shows
// their codes — it keys on the catalogue — but on the page itself the extension
// did nothing at all, because every entry point began by looking up a config
// and giving up when there wasn't one. A shopper on a cart with fourteen live
// codes in our database saw nothing, and if they did reach the apply flow they
// were told "We don't have codes for this store yet" — a sentence about our
// configuration, delivered as a fact about the catalogue, and false.
//
// None of the selectors are needed to help on a platform cart: probe /cart.js,
// GET /discount/{code}, read the total again. So the flow now runs on a
// stand-in record carrying only the domain.
//
// Scale, measured rather than claimed: /cart.js was probed on 40 of those 209
// domains and one answered. Config-less stores are largely config-less because
// there is no cart to read — airlines, restaurants, subscriptions. The apply
// path below is therefore a narrow win; the wide one is the last group in this
// file, where a store with codes was told it had none.
//
// Nothing special-cases that record. A guard was written to stop it falling
// through to a DOM form with no selectors, and then measured against the code
// rather than assumed: the generic path already ends correctly there, finding
// no promo box and offering the codes to copy. The guard only changed the
// wording, so it was removed — and the two cases below are what keeps that
// claim honest rather than remembered.
//
// The bar to appear is unchanged in spirit and still high: a cart-shaped URL,
// a readable cart with something in it, and codes for the domain.

let startApplyingCoupons
let tryInitialize
let caramelConfiglessRecord

let finalModals
let promptedWith
let appliedCodes
let fetchedSites

const COUPONS = [
    {
        code: 'SAVE20',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
    },
    { code: 'TENOFF', id: 'c2', discount_type: 'CASH', discount_amount: 10 },
]

function setPath(pathname) {
    window.history.replaceState({}, '', pathname)
}

const messageOf = call => call[2]
const listOf = call => call[4]

beforeAll(() => {
    ;({ startApplyingCoupons, caramelConfiglessRecord } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['startApplyingCoupons', 'caramelConfiglessRecord'],
    ))
    tryInitialize = globalThis.tryInitialize
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    setPath('/cart')
    finalModals = []
    promptedWith = []
    appliedCodes = []
    fetchedSites = []

    // Codes are cached per page by domain, which is right in a real tab and
    // wrong across tests — without this, a later case sees the previous one's
    // catalogue instead of its own.
    globalThis._caramelCodes = null
    globalThis.showFinalModal = (...args) => finalModals.push(args)
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.insertCaramelPrompt = rec => promptedWith.push(rec)
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = () => {}
    globalThis.waitForElement = async () => {
        throw new Error('not found')
    }
    globalThis.getDomainRecord = async () => null
    globalThis.fetchCoupons = async site => {
        fetchedSites.push(site)
        return COUPONS
    }
    globalThis.probeCartJson = async () => ({
        token: 't',
        total_price: 10000,
        item_count: 2,
        currency: 'USD',
    })
    globalThis.applyViaDiscountLink = async code => {
        appliedCodes.push(code)
        return { token: 't', total_price: 9000, item_count: 2, currency: 'USD' }
    }
})

describe('a checkout on a store with no config row', () => {
    it('offers help instead of staying silent', async () => {
        await tryInitialize()

        expect(promptedWith).toHaveLength(1)
        expect(promptedWith[0].domain).toBe(location.hostname)
    })

    it('stays silent when we hold no codes for it', async () => {
        // A readable cart is not a reason to interrupt someone we cannot help.
        globalThis.fetchCoupons = async () => []

        await tryInitialize()

        expect(promptedWith).toEqual([])
    })

    it('applies codes over the network, which needs no selectors at all', async () => {
        await startApplyingCoupons(caramelConfiglessRecord('shop.example'))

        expect(appliedCodes.length).toBeGreaterThan(0)
        // A link win reloads the page so the store's own UI shows the discount,
        // and hands the result to the fresh document through sessionStorage —
        // so the proof of the win is the handoff, not a modal on this document.
        const handoff = JSON.parse(sessionStorage.getItem('caramel_applied'))
        expect(handoff.code).toBe('SAVE20')
        // $100.00 cart, $90.00 after: a measured drop, config or no config.
        expect(handoff.saved).toBeCloseTo(10, 2)
    })
})

describe('when the cart stops being readable mid-flow', () => {
    beforeEach(() => {
        // The shopper emptied it, or moved into a checkout that no longer
        // answers /cart.js — the one way to reach the DOM path with no config.
        globalThis.probeCartJson = async () => null
    })

    it('does not grind a promo box it has no selectors for', async () => {
        // Spying on the DOM apply itself: with every selector undefined the
        // generic search finds no promo box, so nothing is ever typed at the
        // store. This is the property that makes a special case unnecessary.
        const domAttempts = []
        globalThis.applyCoupon = async (_rec, code) => {
            domAttempts.push(code)
            return { success: false, committed: false, errorIsNew: false }
        }

        await startApplyingCoupons(caramelConfiglessRecord('shop.example'))

        expect(domAttempts).toEqual([])
        expect(appliedCodes).toEqual([])
    })

    it('says what it cannot do and hands the codes over', async () => {
        await startApplyingCoupons(caramelConfiglessRecord('shop.example'))

        expect(finalModals).toHaveLength(1)
        expect(messageOf(finalModals[0])).toMatch(
            /couldn't find the promo box/i,
        )
        expect(listOf(finalModals[0]).map(c => c.code)).toEqual([
            'SAVE20',
            'TENOFF',
        ])
    })
})

describe('the apply flow with no record at all', () => {
    // Reachable after a sign-in message, which looks the record up itself.
    it('does not claim the catalogue is empty when it is holding codes', async () => {
        await startApplyingCoupons(null)

        expect(finalModals).toHaveLength(1)
        expect(messageOf(finalModals[0])).not.toMatch(/don't have codes/i)
        expect(listOf(finalModals[0]).map(c => c.code)).toEqual([
            'SAVE20',
            'TENOFF',
        ])
    })

    it('asks the catalogue about the host it is actually on', async () => {
        await startApplyingCoupons(null)

        expect(fetchedSites).toEqual([location.hostname])
    })

    it('still says so plainly when there really are no codes', async () => {
        globalThis.fetchCoupons = async () => []

        await startApplyingCoupons(null)

        expect(messageOf(finalModals[0])).toMatch(/don't have codes/i)
        expect(listOf(finalModals[0])).toEqual([])
    })

    it('does not turn an unreachable API into a claim about the store', async () => {
        // Offline: we know nothing about the catalogue, so the message has to
        // be about us, and there is nothing to hand over.
        globalThis.fetchCoupons = async () => {
            throw new Error('offline')
        }

        await startApplyingCoupons(null)

        expect(finalModals).toHaveLength(1)
        expect(listOf(finalModals[0])).toEqual([])
    })
})
