import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getOnMessageListeners, loadExtensionSource } from './_load.mjs'

// Pins the sign-in payoff: background.js reads the stored session token
// FRESH per request (the MV3 service worker restarts constantly — no
// module-global cache) and attaches `Authorization: Bearer <token>` to the
// caramel API calls it makes; with no stored token the request goes out
// with no Authorization header at all, exactly as before.
let handler

beforeAll(() => {
    loadExtensionSource('background.js', [])
    ;[handler] = getOnMessageListeners()
    // The permissive chrome stub auto-creates ANY missing member as a
    // truthy callable — including runtime.lastError, which real Chrome
    // leaves undefined on success. Pin it to undefined so getStoredToken's
    // lastError check behaves like the real API.
    globalThis.chrome.runtime.lastError = undefined
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
