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
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'

// A cart page with no served config gets the prompt only from the finder, and
// the finder sees only what has rendered. Detection looked once, at load, and
// the observer that watches a page for a late coupon box was never set up
// without a config. Measured on lasthunt.com, coversandall.com and
// harryrosen.com: the coupon box or the order total is drawn by the store's
// own script after load, so the one look found nothing and the shopper saw no
// prompt for the whole visit.
//
// While the finder is on, a config-less cart page is now looked at again as it
// changes, for a bounded window. With the finder off nothing is observed at
// all, and a store with a served config keeps the observer it always had.

let finderOn
// The next read of the finder flag fails, as an extension message can.
let flagReadFails
// The server-pick rule (caramelFinderMayAsk): does it offer on this page.
let mayAsk

let finderLooks
let probeCalls
let prompted
let couponsForSite
let observers

vi.mock('../coupon-box-discovery.js', async importOriginal => ({
    ...(await importOriginal()),
    caramelCouponBoxDiscoveryOn: async () => {
        if (flagReadFails) {
            flagReadFails = false
            throw new Error('Extension context invalidated')
        }
        return finderOn
    },
    // The finder's rules, reduced to the one fact these cases vary: has the
    // store drawn its coupon box yet.
    caramelFinderSeesBox: () => {
        finderLooks++
        return !!document.getElementById('late-promo')
    },
    caramelFinderMayAsk: async () => mayAsk(),
}))
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    probeCartJson: async () => {
        probeCalls++
        return null
    },
}))
// A configured store's detection waits for its promo selector; jsdom never
// lays one out, so the wait answers "not found" at once instead of on a timer.
vi.mock('../dom-utils.js', async importOriginal => ({
    ...(await importOriginal()),
    waitForElement: async () => {
        throw new Error('not found')
    },
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    insertCaramelPrompt: async rec => {
        prompted.push(rec)
        const pill = document.createElement('div')
        pill.id = 'caramel-small-prompt'
        document.body.appendChild(pill)
    },
}))

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
        if (message?.action === 'fetchCoupons') cb(couponsForSite())
        else cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

// Every observer the page code starts, so a case can say how many are live.
const RealObserver = globalThis.MutationObserver
class CountedObserver extends RealObserver {
    constructor(cb) {
        super(cb)
        this.live = false
        observers.push(this)
    }
    observe(...args) {
        this.live = true
        return super.observe(...args)
    }
    disconnect() {
        this.live = false
        return super.disconnect()
    }
}
const liveObservers = () => observers.filter(o => o.live).length

function setPath(pathname) {
    window.history.replaceState({}, '', pathname)
}

function drawPromoBox() {
    const box = document.createElement('input')
    box.id = 'late-promo'
    document.body.appendChild(box)
}

// A page that keeps changing without ever drawing a box: one mutation a tick.
function churn(n) {
    for (let i = 0; i < n; i++)
        document.body.appendChild(document.createElement('span'))
}

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    globalThis.MutationObserver = CountedObserver
    window.MutationObserver = CountedObserver
})

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sessionStorage.clear()
    document.body.innerHTML = ''
    setPath('/cart')
    finderOn = true
    flagReadFails = false
    mayAsk = () => false

    finderLooks = 0
    probeCalls = 0
    prompted = []
    observers = []
    couponsForSite = () => ({
        coupons: [
            {
                code: 'SAVE20',
                id: 'c1',
                discount_type: 'PERCENTAGE',
                discount_amount: 20,
            },
        ],
    })
    _caramelResetCachedCodes()
    getDomainRecord.cache = []
})

afterEach(() => {
    window.__caramel_second_look?.()
    window.__caramel_checkout_observer?.disconnect()
    window.__caramel_checkout_observer = null
    vi.useRealTimers()
})

describe('a config-less cart page whose coupon box is drawn after load', () => {
    it('gets the prompt once the box appears', async () => {
        await startCheckoutDetection()
        expect(prompted).toHaveLength(0)

        await vi.advanceTimersByTimeAsync(3000)
        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(1000)

        expect(prompted).toHaveLength(1)
        expect(prompted[0].domain).toBe(location.hostname)
        expect(liveObservers()).toBe(0)
    })

    it('does not probe the cart over the network again', async () => {
        await startCheckoutDetection()
        const atLoad = probeCalls

        for (let s = 0; s < 10; s++) {
            churn(1)
            await settle()
            await vi.advanceTimersByTimeAsync(1000)
        }

        expect(probeCalls).toBe(atLoad)
    })

    it('looks at most once a second however busy the page is', async () => {
        await startCheckoutDetection()
        const atLoad = finderLooks

        for (let ms = 0; ms < 3000; ms += 50) {
            churn(5)
            await settle()
            await vi.advanceTimersByTimeAsync(50)
        }

        expect(finderLooks - atLoad).toBeLessThanOrEqual(3)
        expect(finderLooks - atLoad).toBeGreaterThanOrEqual(2)
    })

    it('stops looking after 15 seconds', async () => {
        await startCheckoutDetection()
        expect(liveObservers()).toBe(1)

        await vi.advanceTimersByTimeAsync(15000)
        expect(liveObservers()).toBe(0)

        const before = finderLooks
        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(2000)

        expect(finderLooks).toBe(before)
        expect(prompted).toHaveLength(0)
    })

    it('stops once the finder has offered, even with no codes to show', async () => {
        couponsForSite = () => ({ coupons: [] })
        await startCheckoutDetection()
        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(1000)

        expect(prompted).toHaveLength(0)
        expect(liveObservers()).toBe(0)
    })

    it('stops when the page moves to another URL', async () => {
        await startCheckoutDetection()
        setPath('/checkout/shipping')
        churn(1)
        await settle()
        const before = finderLooks
        await vi.advanceTimersByTimeAsync(1000)

        expect(finderLooks).toBe(before)
        expect(liveObservers()).toBe(0)
    })

    it('starts a fresh window when detection re-runs for a new URL', async () => {
        await startCheckoutDetection()
        await vi.advanceTimersByTimeAsync(10000)

        // What caramelHandleUrlChanged does on a same-page URL change.
        setPath('/cart?step=2')
        await startCheckoutDetection()
        expect(liveObservers()).toBe(1)

        // 12 s into the new window, 22 s after the first one opened.
        await vi.advanceTimersByTimeAsync(11000)
        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(1000)

        expect(prompted).toHaveLength(1)
    })

    it('does not watch a page whose prompt is already up', async () => {
        drawPromoBox()
        await startCheckoutDetection()

        expect(prompted).toHaveLength(1)
        expect(liveObservers()).toBe(0)
    })
})

describe('a config-less cart page whose total is drawn after load', () => {
    // harryrosen.com: no box the rules can see, and no total either until the
    // store's script draws it. Once it does, the server-pick rule offers.
    it('gets the prompt once the server-pick rule offers on the late total', async () => {
        mayAsk = () => !!document.getElementById('late-total')
        await startCheckoutDetection()
        expect(prompted).toHaveLength(0)

        const total = document.createElement('div')
        total.id = 'late-total'
        document.body.appendChild(total)
        await settle()
        await vi.advanceTimersByTimeAsync(1000)

        expect(prompted).toHaveLength(1)
        expect(liveObservers()).toBe(0)
    })
})

describe('a look that fails', () => {
    it('does not end the window: the next change is looked at again', async () => {
        await startCheckoutDetection()
        flagReadFails = true
        churn(1)
        await settle()
        await vi.advanceTimersByTimeAsync(1000)
        expect(prompted).toHaveLength(0)

        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(1000)

        expect(prompted).toHaveLength(1)
    })
})

describe('what does not change', () => {
    it('observes nothing when the store list could not be loaded', async () => {
        // The list fetch answered nothing and nothing is cached: this host may
        // have a config, so the finder does not watch it.
        getDomainRecord.cache = null
        await startCheckoutDetection()
        const atLoad = finderLooks

        drawPromoBox()
        churn(20)
        await settle()
        await vi.advanceTimersByTimeAsync(16000)

        expect(observers).toHaveLength(0)
        expect(finderLooks).toBe(atLoad)
        expect(prompted).toHaveLength(0)
    })

    it('observes nothing with the finder off', async () => {
        finderOn = false
        await startCheckoutDetection()
        drawPromoBox()
        churn(20)
        await settle()
        await vi.advanceTimersByTimeAsync(16000)

        expect(observers).toHaveLength(0)
        expect(prompted).toHaveLength(0)
    })

    it('observes nothing on a page that is not a cart', async () => {
        setPath('/products/linen-shirt')
        await startCheckoutDetection()
        drawPromoBox()
        await settle()
        await vi.advanceTimersByTimeAsync(16000)

        expect(observers).toHaveLength(0)
        expect(prompted).toHaveLength(0)
    })

    it('leaves a store with a served config on the observer it always had', async () => {
        getDomainRecord.cache = [
            { domain: location.hostname, couponInput: '#late-promo' },
        ]
        await startCheckoutDetection()

        expect(window.__caramel_second_look ?? null).toBeNull()
        expect(observers).toHaveLength(1)
        expect(observers[0]).toBe(window.__caramel_checkout_observer)

        // Its page changing for 16 s asks the finder nothing more than the
        // load did: the second look is not running beside its observer.
        const atLoad = finderLooks
        for (let s = 0; s < 16; s++) {
            churn(1)
            await settle()
            await vi.advanceTimersByTimeAsync(1000)
        }
        expect(finderLooks).toBe(atLoad)
    })
})
