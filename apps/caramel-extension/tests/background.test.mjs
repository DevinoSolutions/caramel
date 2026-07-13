import { beforeAll, describe, expect, it } from 'vitest'
import { getOnMessageListeners, loadExtensionSource } from './_load.mjs'

// Characterization pin (F-004), flipped by F-002 — background.js's
// chrome.runtime.onMessage handler no longer collapses a non-ok upstream
// HTTP response into an EMPTY success shape ({coupons:[]} / {supported:[]});
// it now returns {error: `HTTP <status>`}, mirroring the classifyCart
// convention already at background.js:100 (one way per thing). Consumers
// (shared-utils.js fetchCoupons throws on resp.error; the supported-stores
// caller falls back to its expired cache) already tolerate this shape.
let handler

beforeAll(() => {
    globalThis.fetch = async () => ({ ok: false, status: 500 })
    loadExtensionSource('background.js', [])
    ;[handler] = getOnMessageListeners()
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
