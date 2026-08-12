import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Characterization pin (F-004), flipped by F-002 — background.js's
// chrome.runtime.onMessage handler no longer collapses a non-ok upstream
// HTTP response into an EMPTY success shape ({coupons:[]} / {supported:[]});
// it now returns {error: `HTTP <status>`}, mirroring the classifyCart
// convention already at background.js:100 (one way per thing). Consumers
// (shared-utils.js fetchCoupons throws on resp.error; the supported-stores
// caller falls back to its expired cache) already tolerate this shape.
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
    globalThis.fetch = async () => ({ ok: false, status: 500 })
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

describe('background.js onMessage handler — honest failure shaping on fetch failure (F-002)', () => {
    it('registers exactly one onMessage listener', () => {
        expect(typeof handler).toBe('function')
    })

    it('fetchCoupons: HTTP failure resolves to { error: "HTTP <status>" }, not a fake-empty success', async () => {
        const resp = await invoke({
            action: 'fetchCoupons',
            site: 'example.com',
        })
        expect(resp).toEqual({ error: 'HTTP 500' })
    })

    it('fetchSupportedStores: HTTP failure resolves to { error: "HTTP <status>" }, not a fake-empty success', async () => {
        const resp = await invoke({ action: 'fetchSupportedStores' })
        expect(resp).toEqual({ error: 'HTTP 500' })
    })
})

describe('background.js onMessage handler — trust-loop reportOutcome branch (W2)', () => {
    // Recording fetch: the reportOutcome branch is fire-and-forget (the branch
    // never awaits the POSTs), but fetchWithTimeout calls fetch() synchronously,
    // so both calls are recorded before sendResponse resolves invoke().
    let calls
    beforeEach(() => {
        calls = []
        globalThis.fetch = async (url, opts) => {
            calls.push({ url: String(url), opts })
            return { ok: true, status: 200, json: async () => ({}) }
        }
    })

    it('worked: POSTs the report AND bumps the usage counter (storeReason omitted from the body)', async () => {
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'worked',
        })
        expect(resp).toEqual({ success: true })

        const report = calls.find(c => c.url.includes('/api/coupons/42/report'))
        expect(report).toBeTruthy()
        expect(report.opts.method).toBe('POST')
        expect(JSON.parse(report.opts.body)).toEqual({ outcome: 'worked' })

        const increment = calls.find(c =>
            c.url.includes('/api/coupons/increment'),
        )
        expect(increment).toBeTruthy()
        expect(increment.opts.method).toBe('POST')
        expect(JSON.parse(increment.opts.body)).toEqual({ id: '42' })
    })

    it('failed: POSTs the report with storeReason and does NOT bump the counter', async () => {
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'failed',
            storeReason: 'Expired',
        })
        expect(resp).toEqual({ success: true })

        const report = calls.find(c => c.url.includes('/api/coupons/42/report'))
        expect(report).toBeTruthy()
        expect(report.opts.method).toBe('POST')
        expect(JSON.parse(report.opts.body)).toEqual({
            outcome: 'failed',
            storeReason: 'Expired',
        })

        expect(
            calls.find(c => c.url.includes('/api/coupons/increment')),
        ).toBeFalsy()
    })
})
