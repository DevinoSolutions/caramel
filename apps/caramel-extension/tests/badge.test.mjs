import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Pins the toolbar badge: per-tab coupon count for the active site,
// sourced from GET /api/coupons?site=<domain>&limit=1 (only `total` is
// read), cached per domain, cleared on non-http tabs, capped at "99+".
let updateBadgeForTab
let badgeCalls
let fetchCalls

// The worker realm background.js expects, lifted from the tests/_load.mjs
// harness this suite no longer uses. Both halves must be in place BEFORE the
// module is imported:
//
//  1. The permissive chrome Proxy — anything not explicitly set answers as a
//     callable no-op, so the API surface initBackground() touches on the way
//     past (alarms, badge styling, tab listeners) never throws.
//  2. ServiceWorkerGlobalScope — background.js decides AT MODULE EVAL whether
//     it is an MV3 service worker, and its non-worker fallback keep-alive is a
//     bare setInterval that holds the runner's event loop open forever. Chrome
//     and Safari really do run this file as a service worker, so the realm
//     says so and keepAlive() takes the chrome.alarms branch.
function installWorkerRealm() {
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
    // Real Chrome invokes storage callbacks (empty storage) and leaves
    // runtime.lastError undefined outside a failed callback. The bare proxy
    // does neither, which leaves getStoredToken's promise pending forever and
    // its lastError check reading a truthy auto-created no-op.
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
        stub.storage[area].remove = (_keys, cb) => cb?.()
    }
    stub.runtime.lastError = undefined
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

beforeAll(async () => {
    globalThis.fetch = async url => {
        fetchCalls.push(String(url))
        return {
            ok: true,
            status: 200,
            json: async () => ({ coupons: [], total: 7 }),
        }
    }
    installWorkerRealm()
    // ONE import for the whole file: the per-domain count cache the second
    // test asserts on is module state, which a reload would throw away.
    const background = await import('../background.js')
    background.initBackground()
    updateBadgeForTab = background.updateBadgeForTab
})

beforeEach(() => {
    badgeCalls = []
    fetchCalls = []
    // background.js binds `currentBrowser` to the stub installed above —
    // same object, so overwriting the member here is what _setBadge calls.
    globalThis.chrome.action.setBadgeText = args => badgeCalls.push(args)
})

describe('background.js toolbar badge', () => {
    it('sets the coupon count for an https tab', async () => {
        await updateBadgeForTab(1, 'https://www.example.com/cart')
        expect(badgeCalls).toEqual([{ tabId: 1, text: '7' }])
        expect(fetchCalls[0]).toContain('site=example.com')
        expect(fetchCalls[0]).toContain('limit=1')
    })

    it('caches the count per domain — a second tab on the same site does not refetch', async () => {
        await updateBadgeForTab(2, 'https://example.com/')
        expect(badgeCalls).toEqual([{ tabId: 2, text: '7' }])
        expect(fetchCalls).toEqual([]) // served from the first test's cache
    })

    it('clears the badge on non-http tabs', async () => {
        await updateBadgeForTab(3, 'chrome://extensions')
        expect(badgeCalls).toEqual([{ tabId: 3, text: '' }])
        expect(fetchCalls).toEqual([])
    })

    it('caps the badge text at 99+', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ coupons: [], total: 240 }),
        })
        await updateBadgeForTab(4, 'https://busy-store.com/')
        expect(badgeCalls).toEqual([{ tabId: 4, text: '99+' }])
    })

    it('clears the badge when the count fetch fails (offline)', async () => {
        globalThis.fetch = async () => {
            throw new Error('offline')
        }
        await updateBadgeForTab(5, 'https://unreachable-store.com/')
        expect(badgeCalls).toEqual([{ tabId: 5, text: '' }])
    })
})
