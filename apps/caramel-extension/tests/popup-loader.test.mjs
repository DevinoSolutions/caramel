import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initPopupEntry } from '../popup.js'

// D4 pin (audit/ext-e2e-report.md #5, ext-config-trace.md §5.4) — the popup
// loader used to hide on a fixed 400ms setTimeout, completely detached from
// the actual coupon request (which can take up to background.js's
// FETCH_TIMEOUT_MS, 8s). E2E reproduced the resulting blank `auth-container`
// gap on a slow/degraded connection. The fix ties loader visibility to the
// real popup.js DOMContentLoaded listener (not initPopup() directly — this
// exercises the actual production wiring, same as a real popup open) via a
// synthetic DOMContentLoaded dispatch, matching this suite's "go through the
// real listener chain, stub only the messaging transport" convention
// (popup.test.mjs).

let chromeStub

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval, inlined here now that
 * the sources are ES modules: anything not explicitly set answers with a
 * callable no-op, storage callbacks fire the way the real API does, and
 * runtime.lastError starts UNDEFINED (a permissive proxy would auto-create a
 * truthy callable, which caramel-base.js reads as a closed port). */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = target => {
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
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

beforeAll(() => {
    initCouponConstants()
    chromeStub = installChromeStub()
    // The DOMContentLoaded registration used to be a top-level statement in
    // popup.js and arrived just by loading the file; it lives in
    // initPopupEntry() now, which entrypoints/popup/main.ts calls last in realm
    // order. Same listener, same document — the dispatches below still drive
    // the production wiring rather than initPopup() directly.
    initPopupEntry()
})

beforeEach(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'
    chromeStub.storage.sync.get = (_keys, cb) => cb({})
    vi.useFakeTimers()
})

describe('popup.js DOMContentLoaded — loader tracks the real fetch lifecycle (D4)', () => {
    it('slow-resolving transport: spinner stays visible at +1s, content renders once it resolves', async () => {
        let deliverCoupons
        chromeStub.runtime.sendMessage = (message, cb) => {
            if (message?.action === 'getActiveTabDomainRecord') {
                cb({ url: 'https://example.com/cart' })
            } else if (message?.action === 'fetchCoupons') {
                // Captured, not delivered yet — simulates a request that's
                // still in flight (real-world: up to ~8s).
                deliverCoupons = () =>
                    cb({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
            } else {
                cb(undefined)
            }
        }

        document.dispatchEvent(new Event('DOMContentLoaded'))
        // Flush the synchronous-callback prefix (getActiveTabDomainRecord,
        // the storage.sync.get dispatch) so the coupon request's own
        // sendMessage call has actually happened and deliverCoupons is
        // assigned.
        await vi.advanceTimersByTimeAsync(50)
        expect(typeof deliverCoupons).toBe('function')

        const loader = document.getElementById('loading-container')
        expect(loader.style.display).not.toBe('none')

        // Old behavior hid the loader on a flat 400ms timer; the fetch is
        // still pending well past that point here.
        await vi.advanceTimersByTimeAsync(1000)
        expect(loader.style.display).not.toBe('none')
        expect(document.getElementById('couponList')).toBeNull()

        deliverCoupons()
        await vi.advanceTimersByTimeAsync(500)

        expect(loader.style.display).toBe('none')
        expect(document.getElementById('couponList')).not.toBeNull()
    })

    it('rejecting transport: shows the load-error state (not a blank window) and hides the spinner', async () => {
        chromeStub.runtime.sendMessage = (message, cb) => {
            if (message?.action === 'getActiveTabDomainRecord') {
                cb({ url: 'https://example.com/cart' })
            } else if (message?.action === 'fetchCoupons') {
                setTimeout(() => cb({ error: 'HTTP 500' }), 600)
            } else {
                cb(undefined)
            }
        }

        document.dispatchEvent(new Event('DOMContentLoaded'))
        await vi.advanceTimersByTimeAsync(50)

        const loader = document.getElementById('loading-container')
        const authContainer = document.getElementById('auth-container')

        // Still in flight: this is exactly the window D4 left blank
        // (spinner already gone, error content not painted yet). Assert the
        // spinner is still covering it instead of a bare container.
        await vi.advanceTimersByTimeAsync(500)
        expect(loader.style.display).not.toBe('none')
        expect(authContainer.innerHTML).not.toContain("Couldn't load coupons")

        await vi.advanceTimersByTimeAsync(500)

        expect(loader.style.display).toBe('none')
        expect(authContainer.innerHTML).toContain("Couldn't load coupons")
    })
})
