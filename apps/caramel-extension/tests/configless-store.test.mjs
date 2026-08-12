import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    caramelConfiglessRecord,
    getDomainRecord,
    tryInitialize,
} from '../store-detect.js'

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

// The collaborators the old harness replaced on globalThis are module imports
// now, so each is replaced in the module the flow reads it from. The factories
// delegate to mutable impls because vi.mock is hoisted and several tests swap
// one for their own case.
let applyCouponImpl
let probeCartJsonImpl
vi.mock('../coupon-apply.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // Unstubbed by default — one test spies on it, and the rest rely on the
        // real generic search finding no promo box.
        applyCoupon: (...args) =>
            (applyCouponImpl ?? actual.applyCoupon)(...args),
        probeCartJson: (...args) => probeCartJsonImpl(...args),
        applyViaDiscountLink: async code => {
            appliedCodes.push(code)
            return {
                token: 't',
                total_price: 9000,
                item_count: 2,
                currency: 'USD',
            }
        },
    }
})
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: (...args) => finalModals.push(args),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: rec => promptedWith.push(rec),
}))
vi.mock('../dom-utils.js', async importOriginal => ({
    ...(await importOriginal()),
    waitForElement: async () => {
        throw new Error('not found')
    },
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is assigned by initCaramelBase(); a spread would
        // freeze the pre-init undefined, so the live binding is forwarded.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
    }
})

/* The coupon catalogue is NOT mocked at the module boundary: coupon-fetch and
 * store-detect import each other, and a vi.mock factory that has to evaluate
 * the real coupon-fetch (importOriginal) is still mid-flight when store-detect
 * asks for it — so getCachedCodes binds the real fetchCoupons and the stub is
 * silently bypassed. Stubbing the TRANSPORT instead (the service-worker message
 * fetchCouponsPage sends) has no such hazard and exercises more of the path. */
let couponsForSite
function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'fetchCoupons') {
            fetchedSites.push(message.site)
            cb(couponsForSite())
        } else {
            cb({})
        }
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
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
    _caramelResetCachedCodes()
    // A store list that holds no row for this host: getDomainRecord's own
    // "no config" answer, rather than a stub standing in front of it.
    getDomainRecord.cache = []
    applyCouponImpl = null
    couponsForSite = () => ({ coupons: COUPONS })
    probeCartJsonImpl = async () => ({
        token: 't',
        total_price: 10000,
        item_count: 2,
        currency: 'USD',
    })
})

describe('a checkout on a store with no config row', () => {
    it('offers help instead of staying silent', async () => {
        await tryInitialize()

        expect(promptedWith).toHaveLength(1)
        expect(promptedWith[0].domain).toBe(location.hostname)
    })

    it('stays silent when we hold no codes for it', async () => {
        // A readable cart is not a reason to interrupt someone we cannot help.
        couponsForSite = () => ({ coupons: [] })

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
        probeCartJsonImpl = async () => null
    })

    it('does not grind a promo box it has no selectors for', async () => {
        // Spying on the DOM apply itself: with every selector undefined the
        // generic search finds no promo box, so nothing is ever typed at the
        // store. This is the property that makes a special case unnecessary.
        const domAttempts = []
        applyCouponImpl = async (_rec, code) => {
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
        couponsForSite = () => ({ coupons: [] })

        await startApplyingCoupons(null)

        expect(messageOf(finalModals[0])).toMatch(/don't have codes/i)
        expect(listOf(finalModals[0])).toEqual([])
    })

    it('does not turn an unreachable API into a claim about the store', async () => {
        // Offline: we know nothing about the catalogue, so the message has to
        // be about us, and there is nothing to hand over.
        // The worker reports its own failures in-band; fetchCouponsPage turns
        // an `error` field into the throw the old stub raised directly.
        couponsForSite = () => ({ error: 'offline' })

        await startApplyingCoupons(null)

        expect(finalModals).toHaveLength(1)
        expect(listOf(finalModals[0])).toEqual([])
    })
})
