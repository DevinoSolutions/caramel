import { beforeEach, describe, expect, it, vi } from 'vitest'

// Background half of the fleet-silence fix (2026-08-07, content-script half
// pinned in silent-fetch-failure.test.mjs): every Caramel API call used one
// 8 s abort budget, but the supported-stores payload is ~1.14 MB and a cold
// MV3 service-worker fetch of it measured 6.7 s to >60 s — so the bulk call
// aborted routinely and the extension went silent. The bulk call now gets a
// budget it can meet, plus one retry (the measured cold fetch is the slow
// one; the warm retry lands in seconds). Both pins fail against the pre-fix
// code (single shared 8000 ms budget, no retry).

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
//     says so and keepAlive() takes the chrome.alarms branch. That also keeps
//     this suite's setTimeout spy reading only the fetch budgets.
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

// A fresh realm AND a fresh module registry per call: each test needs its own
// worker, exactly as the old per-test source eval gave it.
async function loadBackground() {
    vi.resetModules()
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
}

function invoke(message) {
    return new Promise(resolve => handler(message, {}, resolve))
}

beforeEach(() => {
    vi.restoreAllMocks()
})

describe('background.js fetchSupportedStores — the bulk store list gets a budget it can actually meet', () => {
    it('arms the 30s bulk budget, not the 8s default', async () => {
        globalThis.fetch = () =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ supported: [] }),
            })
        await loadBackground()
        const delays = []
        const realSetTimeout = globalThis.setTimeout
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
            delays.push(ms)
            return realSetTimeout(fn, ms)
        })
        await invoke({ action: 'fetchSupportedStores' })
        globalThis.setTimeout.mockRestore()
        expect(delays).toContain(30000)
        expect(delays).not.toContain(8000)
    })

    it('a first fetch that dies on the wire is retried, and the retry payload is delivered', async () => {
        let calls = 0
        globalThis.fetch = () => {
            calls++
            if (calls === 1)
                return Promise.reject(
                    new DOMException('signal is aborted', 'AbortError'),
                )
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ supported: [{ domain: 'example.com' }] }),
            })
        }
        await loadBackground()
        const resp = await invoke({ action: 'fetchSupportedStores' })
        expect(calls).toBe(2)
        expect(resp).toEqual({ supported: [{ domain: 'example.com' }] })
    })

    it('when the retry also dies, the reply carries the error in-band (consumers treat it as failure, not "no stores")', async () => {
        globalThis.fetch = () =>
            Promise.reject(new DOMException('signal is aborted', 'AbortError'))
        await loadBackground()
        const resp = await invoke({ action: 'fetchSupportedStores' })
        expect(resp.error).toMatch(/abort/i)
    })
})
