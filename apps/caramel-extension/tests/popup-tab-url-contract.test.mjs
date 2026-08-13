import { beforeAll, describe, expect, it, vi } from 'vitest'

// Producer/consumer CONTRACT pin for getActiveTabDomainRecord — born from a
// live bug (eBay, iOS Safari, 2026-08-09): background.js answered with
// `new URL(tabUrl).hostname` ("www.ebay.com") while popup.js's non-web-tab
// guard (`/^https?:\/\//`) requires a scheme, so EVERY real store nulled to
// "no active tab" and the popup skipped its coupon fetch — showing the
// "Ready when you are" empty state (plus a Log in button) on sites the
// extension had just flagged as having coupons. The store had 96 live eBay
// coupons at the time; nothing was wrong server-side.
//
// Every other popup suite stubs the service worker with a hand-written
// payload (`cb({ url: 'https://example.com/cart' })`), which is exactly how
// the drift stayed invisible: the fixtures described the contract, the
// producer broke it, and no test ran the two against each other. This suite
// closes that hole by capturing the REAL background.js handler's response
// and feeding it — unedited — to the REAL popup.
//
// (jsdom lacks a service-worker realm, so producer and consumer are loaded
// into separate module realms and bridged by replaying the captured payload —
// the payload itself is never hand-authored. `vi.resetModules()` before each
// dynamic import is what gives each realm its own module instances, the
// successor to the old harness's one-fresh-eval-per-load.)
//
// ONE chrome stub for the whole file, installed once. initCaramelBase() is NOT
// idempotent across stubs: it latches on `window.__caramel_shared_utils_loaded`,
// which outlives vi.resetModules(), so a second installChromeStub() would leave
// `currentBrowser` bound to the FIRST stub and every per-run handler written to
// the second one would be read by nobody. Per-run freshness comes from
// re-pointing this stub's handlers instead of rebuilding it.

const STORE_TAB_URL = 'https://www.ebay.com/itm/1234567890?campid=abc'
const NON_WEB_TAB_URL = 'chrome://newtab/'

/* Realm stub, lifted from tests/_load.mjs (installChromeStub +
 * getOnMessageListeners), which the ESM port retires. Permissive Proxy: any
 * unknown property materializes as a callable no-op, so a source file touching
 * an API this suite doesn't care about cannot abort it. The deliberate
 * exceptions, exactly as _load.mjs had them — storage.*.get/set/remove invoke
 * their callbacks like the real API (empty storage), runtime.lastError stays
 * UNDEFINED outside a failing callback, and runtime.onMessage.addListener
 * RECORDS real listeners so this suite can invoke background.js's handler
 * directly (`stub.onMessageListeners`). */
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

    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    stub.runtime.onMessage.removeListener = fn => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = fn => listeners.includes(fn)
    stub.onMessageListeners = listeners

    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

// The one stub every realm in this file shares — see the header note on the
// initCaramelBase latch.
let realmStub

beforeAll(() => {
    realmStub = installChromeStub()
})

/** Runs the real background.js onMessage handler for a tab whose full URL is
 * `tabUrl` and resolves with the getActiveTabDomainRecord payload. */
async function captureProducerPayload(tabUrl) {
    vi.resetModules()
    realmStub.onMessageListeners.length = 0
    const { initBackground } = await import('../background.js')
    initBackground()
    const [handler] = realmStub.onMessageListeners
    realmStub.tabs.query = (_query, cb) => cb([{ url: tabUrl }])
    return new Promise(resolve =>
        handler({ action: 'getActiveTabDomainRecord' }, {}, resolve),
    )
}

/** Loads the real popup logic stack, replays `payload` as the service
 * worker's getActiveTabDomainRecord answer, runs resolvePopupState() (the P2
 * successor to initPopup — it returns the view instead of painting it; the
 * paint itself is the React shell suite's pin), and reports what the popup
 * did: which site (if any) it fetched coupons for, and which view it chose. */
async function runPopupAgainst(payload) {
    // Same realm inits, in the same order, as entrypoints/popup/main.tsx.
    vi.resetModules()
    realmStub.onMessageListeners.length = 0
    const { initCaramelBase } = await import('../caramel-base.js')
    const { initCouponConstants } = await import(
        '../coupon-constants.generated.js'
    )
    const { initCouponRunner } = await import('../coupon-runner.js')
    const { resolvePopupState } = await import('../popup-core.js')
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

    const observed = { fetchedSite: null }
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb(payload)
        } else if (message?.action === 'fetchCoupons') {
            observed.fetchedSite = message.site
            cb({
                coupons: [
                    {
                        id: 1,
                        code: 'CONTRACT10',
                        title: '10% off',
                        status: 'valid',
                    },
                ],
            })
        } else {
            cb(undefined)
        }
    }
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) => cb({})

    const state = await resolvePopupState()
    return { observed, state }
}

describe('getActiveTabDomainRecord producer/consumer contract', () => {
    let storePayload
    let nonWebPayload

    beforeAll(async () => {
        // Capture both payloads from the REAL producer up front, before any
        // popup realm is built — the worker realm and the popup realm share one
        // chrome stub, so the two are kept strictly sequential.
        storePayload = await captureProducerPayload(STORE_TAB_URL)
        nonWebPayload = await captureProducerPayload(NON_WEB_TAB_URL)
    })

    it('producer answers with the FULL tab URL (scheme included), never a bare hostname', () => {
        expect(storePayload.url).toBe(STORE_TAB_URL)
    })

    it('a store tab resolves to the coupon list, fetching by hostname without www/path/query', async () => {
        const { observed, state } = await runPopupAgainst(storePayload)
        expect(observed.fetchedSite).toBe('ebay.com')
        // The empty state that shipped to eBay users must NOT be what resolves.
        expect(state.view).toBe('coupons')
        expect(state.domain).toBe('ebay.com')
        expect(state.coupons.map(c => c.code)).toContain('CONTRACT10')
    })

    it('a non-web tab still lands on the introduction view without fetching (PR #143 behavior preserved)', async () => {
        const { observed, state } = await runPopupAgainst(nonWebPayload)
        expect(observed.fetchedSite).toBeNull()
        expect(state.view).toBe('unsupported')
        expect(state.domain).toBeUndefined()
    })
})
