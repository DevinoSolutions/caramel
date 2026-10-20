import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The badge count shares the per-IP burst budget (20 requests in 2s) with the
// coupon list a shopper opens at checkout. Restoring a window of tabs used to
// fetch a count for every tab at once, twice per navigation (URL change and
// load complete), and kept going through 429s, so the badge could get the
// shopper's own coupon list refused (Sentry: burst rejections on
// GET /api/coupons from real browsers, iPhone Safari among them).
let bg
let fetchCalls
let badgeCalls
let respond
let tabsById

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
        return respond(String(url))
    }
    installWorkerRealm()
    bg = await import('../background.js')
    bg.initBackground()
})

beforeEach(() => {
    fetchCalls = []
    badgeCalls = []
    tabsById = {}
    respond = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ coupons: [], total: 3 }),
    })
    globalThis.chrome.action.setBadgeText = args => badgeCalls.push(args)
    globalThis.chrome.tabs.get = (id, cb) => cb(tabsById[id])
})

const flush = () => new Promise(r => setTimeout(r, 0))
let n = 0
const fresh = () => `store-${++n}-${Date.now()}.example`

describe('the toolbar badge does not burst the shared rate limit', () => {
    it('counts nothing for tabs that load out of sight', async () => {
        for (let i = 0; i < 25; i++) {
            const url = `https://${fresh()}/`
            const tab = { id: 100 + i, url, active: false }
            bg._caramelOnTabUpdated(tab.id, { url }, tab)
            bg._caramelOnTabUpdated(tab.id, { status: 'complete' }, tab)
        }
        await flush()
        expect(fetchCalls).toEqual([])
    })

    it('counts a background tab once the shopper switches to it', async () => {
        const url = `https://${fresh()}/cart`
        tabsById[7] = { id: 7, url, active: true }
        bg._caramelOnTabActivated({ tabId: 7 })
        await flush()
        await flush()
        expect(fetchCalls).toHaveLength(1)
        expect(badgeCalls).toEqual([{ tabId: 7, text: '3' }])
    })

    it('asks once when a navigation reports both its URL and its load', async () => {
        const url = `https://${fresh()}/`
        const tab = { id: 8, url, active: true }
        bg._caramelOnTabUpdated(8, { url }, tab)
        bg._caramelOnTabUpdated(8, { status: 'complete' }, tab)
        await flush()
        await flush()
        expect(fetchCalls).toHaveLength(1)
    })

    it('still counts the tab in front, as before', async () => {
        const url = `https://${fresh()}/`
        bg._caramelOnTabUpdated(9, { url }, { id: 9, url })
        await flush()
        await flush()
        expect(fetchCalls).toHaveLength(1)
        expect(badgeCalls).toEqual([{ tabId: 9, text: '3' }])
    })

    it('stops asking for as long as a 429 says, and does not cache a zero', async () => {
        respond = async () => ({
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '30' }),
            json: async () => ({}),
        })
        const first = fresh()
        await bg.updateBadgeForTab(10, `https://${first}/`)
        for (let i = 0; i < 10; i++)
            await bg.updateBadgeForTab(11 + i, `https://${fresh()}/`)
        expect(fetchCalls).toHaveLength(1)

        // After the wait, the refused domain is asked again: its count was
        // unknown, not zero.
        respond = async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ coupons: [], total: 5 }),
        })
        const realNow = Date.now
        Date.now = () => realNow() + 31_000
        try {
            badgeCalls = []
            await bg.updateBadgeForTab(30, `https://${first}/`)
        } finally {
            Date.now = realNow
        }
        expect(fetchCalls).toHaveLength(2)
        expect(badgeCalls).toEqual([{ tabId: 30, text: '5' }])
    })
})
