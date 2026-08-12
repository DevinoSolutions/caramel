import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Pins the sign-in payoff: background.js reads the stored session token
// FRESH per request (the MV3 service worker restarts constantly — no
// module-global cache) and attaches `Authorization: Bearer <token>` to the
// caramel API calls it makes; with no stored token the request goes out
// with no Authorization header at all, exactly as before.
let handler

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
    // its lastError check reading a truthy auto-created no-op — the precise
    // fidelity this suite depends on, since it drives getStoredToken directly.
    // storage.local answering {} is also what routes the read to the sync
    // fallback the tests below script.
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
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
})

function invoke(message) {
    return new Promise(resolve => {
        handler(message, {}, resolve)
    })
}

// The reportOutcome branch is fire-and-forget and the token read defers the
// fetch to a microtask — settle the chains before asserting.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('background.js caramel API calls — session bearer attachment', () => {
    let calls
    beforeEach(() => {
        calls = []
        globalThis.fetch = async (url, opts) => {
            calls.push({ url: String(url), opts })
            return {
                ok: true,
                status: 200,
                json: async () => ({ coupons: [] }),
            }
        }
    })

    it('fetchCoupons: attaches Authorization: Bearer <token> when a token is stored', async () => {
        globalThis.chrome.storage.sync.get = (_keys, cb) =>
            cb({ token: 'tok-123' })
        await invoke({ action: 'fetchCoupons', site: 'example.com' })
        await flush()
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toContain('/api/coupons')
        expect(calls[0].opts.headers.Authorization).toBe('Bearer tok-123')
    })

    it('fetchCoupons: sends NO Authorization header when no token is stored', async () => {
        globalThis.chrome.storage.sync.get = (_keys, cb) => cb({})
        await invoke({ action: 'fetchCoupons', site: 'example.com' })
        await flush()
        expect(calls).toHaveLength(1)
        const headers = calls[0].opts?.headers || {}
        expect('Authorization' in headers).toBe(false)
    })

    it('reportOutcome (worked): attaches the bearer to BOTH the report and the usage increment, keeping Content-Type', async () => {
        globalThis.chrome.storage.sync.get = (_keys, cb) =>
            cb({ token: 'tok-123' })
        const resp = await invoke({
            action: 'reportOutcome',
            id: '7',
            outcome: 'worked',
        })
        expect(resp).toEqual({ success: true })
        await flush()

        const report = calls.find(c => c.url.includes('/api/coupons/7/report'))
        expect(report).toBeTruthy()
        expect(report.opts.headers.Authorization).toBe('Bearer tok-123')
        expect(report.opts.headers['Content-Type']).toBe('application/json')

        const increment = calls.find(c =>
            c.url.includes('/api/coupons/increment'),
        )
        expect(increment).toBeTruthy()
        expect(increment.opts.headers.Authorization).toBe('Bearer tok-123')
    })

    it('classifyCart and fetchSupportedStores: attach the bearer when a token is stored', async () => {
        globalThis.chrome.storage.sync.get = (_keys, cb) =>
            cb({ token: 'tok-123' })
        await invoke({ action: 'classifyCart', signals: {} })
        await invoke({ action: 'fetchSupportedStores' })
        await flush()

        const classify = calls.find(c => c.url.includes('/api/classify-cart'))
        expect(classify).toBeTruthy()
        expect(classify.opts.headers.Authorization).toBe('Bearer tok-123')

        const stores = calls.find(c =>
            c.url.includes('/api/extension/supported-stores'),
        )
        expect(stores).toBeTruthy()
        expect(stores.opts.headers.Authorization).toBe('Bearer tok-123')
    })
})
