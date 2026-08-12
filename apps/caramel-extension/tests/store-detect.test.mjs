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

// D3 pin (audit/ext-e2e-report.md #8, ext-config-trace.md §5.5) —
// startCheckoutDetection()'s SPA re-detection MutationObserver is the sole
// safety net for a coupon box that appears AFTER the initial page-load
// check (drawer carts, SPA route changes — see the function's own doc
// comment). E2E reproduced it catching a freshly-INSERTED box but missing
// an already-present box that's merely revealed via a class/style toggle,
// because the observer only watched `childList`. The fix widens the SAME
// observer to also watch class/style/hidden attribute changes, feeding the
// exact same debounce (`scheduled` + one setTimeout(recheck, 400)) — no new
// mechanism. These pins drive both signal shapes through the real function.
let currentRec = null

/* The permissive chrome stub the old harness installed, kept here because this
 * suite runs the REAL insertCaramelPrompt (UI-helpers) and the real coupon
 * fetch: anything not explicitly known has to be a callable no-op rather than a
 * TypeError. Lifted from tests/_load.mjs, which the ESM port retires. */
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
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    // Real Chrome leaves lastError undefined except inside a failed callback;
    // the proxy would otherwise mint a truthy callable caramelSendMessage reads
    // as a closed port.
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

beforeAll(() => {
    const chromeStub = installChromeStub()
    initCaramelBase()

    // getDomainRecord's prod-TTL path (ttl>0, since vitest.config.mjs defines
    // the PRODUCTION environment stamp) reads chrome.storage.local before
    // falling back to the fetchSupportedStores message — stub both legs of that
    // chain. Real response shapes match background.js's contract
    // (background.test.mjs).
    chromeStub.storage.local.get = (_keys, cb) => cb({})
    chromeStub.storage.local.set = () => {}
    chromeStub.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'fetchSupportedStores') {
            cb({ supported: currentRec ? [currentRec] : [] })
        } else if (message?.action === 'fetchCoupons') {
            cb({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
        } else {
            cb(undefined)
        }
    }
})

beforeEach(() => {
    document.body.innerHTML = ''
    // Re-injection guards are the whole point of this suite — must not leak
    // a previous test's observer/cache into the next one.
    window.__caramel_checkout_observer = null
    getDomainRecord.cache = null
    _caramelResetCachedCodes()
    currentRec = null
    vi.useFakeTimers()
})

afterEach(() => {
    window.__caramel_checkout_observer?.disconnect()
    window.__caramel_checkout_observer = null
    vi.useRealTimers()
})

// jsdom never computes real layout (offsetParent/display are inert), so
// _isVisible's checkVisibility() branch is the deterministic hook this repo
// already leans on for visibility-dependent tests — same idea as
// shared-utils.test.mjs's Object.defineProperty(el, 'innerText', ...).
function setVisible(el, visible) {
    el.checkVisibility = () => visible
}

describe('store-detect.js startCheckoutDetection — SPA re-detection (D3)', () => {
    it('(a) a node inserted after the initial check still triggers the prompt', async () => {
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-a',
            showInput: null,
        }

        const done = startCheckoutDetection()
        // Nothing matches '#promo-a' yet, so isCheckout()'s internal 3s
        // grace (dom-utils.js waitForElement) has to time out before the
        // initial tryInitialize() gives up and startCheckoutDetection()
        // arms the recheck observer under test.
        await vi.advanceTimersByTimeAsync(3100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        const node = document.createElement('input')
        node.id = 'promo-a'
        setVisible(node, true)
        document.body.appendChild(node)

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })

    it('(b) a class/style toggle on a PRE-EXISTING hidden node triggers the prompt', async () => {
        const node = document.createElement('input')
        node.id = 'promo-b'
        node.className = 'drawer-hidden'
        setVisible(node, false)
        document.body.appendChild(node)
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-b',
            showInput: null,
        }

        const done = startCheckoutDetection()
        // The node already exists (just hidden), so isCheckout()'s
        // waitForElement resolves "found-immediately" — no 3s wait here.
        await vi.advanceTimersByTimeAsync(100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        // No new node — only an attribute/visibility change on the SAME
        // pre-rendered element (the SPA drawer-cart reveal this defect
        // missed: childList alone never fires for this).
        setVisible(node, true)
        node.className = 'drawer-visible'

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })

    it('(c) a childList insertion and an attribute toggle firing together still insert exactly one prompt', async () => {
        const node = document.createElement('input')
        node.id = 'promo-c'
        node.className = 'drawer-hidden'
        setVisible(node, false)
        document.body.appendChild(node)
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-c',
            showInput: null,
        }

        const done = startCheckoutDetection()
        await vi.advanceTimersByTimeAsync(100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        // Both signal types inside the same synchronous block, so they land
        // in the same debounce window: an unrelated node insertion
        // (childList) plus the visibility toggle (attributes) on the
        // pre-existing node.
        const extra = document.createElement('div')
        extra.id = 'unrelated-insert'
        document.body.appendChild(extra)
        setVisible(node, true)
        node.className = 'drawer-visible'

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.querySelectorAll('#caramel-small-prompt').length).toBe(
            1,
        )
    })
})

// A config is only safe if it is applied to the RIGHT site. The hostname
// matcher decides that, so its boundaries are pinned here: every hyphenated
// checkout host present in the live catalog must still resolve, while a
// look-alike domain an attacker could register must not inherit a store's
// selectors and coupons.
describe('store-detect.js — hostname matching boundaries', () => {
    const lookup = async (host, domains) => {
        getDomainRecord.cache = domains.map(d => ({ domain: d }))
        return getDomainRecord(host)
    }

    it.each([
        ['secure-athleta.gap.com', 'athleta.gap.com'],
        ['secure-oldnavy.gapcanada.ca', 'oldnavy.gapcanada.ca'],
        [
            'secure-bananarepublicfactory.gapfactory.com',
            'bananarepublicfactory.gapfactory.com',
        ],
        ['secure-us.braun.com', 'us.braun.com'],
        ['www.target.com', 'target.com'],
        ['checkout.shopify-store.com', 'shopify-store.com'],
        ['target.com', 'target.com'],
    ])('matches real host %s to %s', async (host, domain) => {
        expect(await lookup(host, [domain])).toEqual({ domain })
    })

    it.each([
        // attacker-registered look-alikes
        ['evil-target.com', 'target.com'],
        ['nottarget.com', 'target.com'],
        ['secure-target.com', 'target.com'],
        ['target.com.attacker.net', 'target.com'],
        // unrelated hosts that plain substring matching used to false-match
        ['walmart.com', 'art.com'],
        ['notbestbuy.com', 'bestbuy.com'],
    ])('does NOT apply %s config to %s', async (host, domain) => {
        expect(await lookup(host, [domain])).toBeUndefined()
    })
})
