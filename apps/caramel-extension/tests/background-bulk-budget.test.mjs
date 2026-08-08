import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOnMessageListeners, loadExtensionSource } from './_load.mjs'

// Background half of the fleet-silence fix (2026-08-07, content-script half
// pinned in silent-fetch-failure.test.mjs): every Caramel API call used one
// 8 s abort budget, but the supported-stores payload is ~1.14 MB and a cold
// MV3 service-worker fetch of it measured 6.7 s to >60 s — so the bulk call
// aborted routinely and the extension went silent. The bulk call now gets a
// budget it can meet, plus one retry (the measured cold fetch is the slow
// one; the warm retry lands in seconds). Both pins fail against the pre-fix
// code (single shared 8000 ms budget, no retry).

let handler

function loadBackground() {
    loadExtensionSource('background.js', [])
    ;[handler] = getOnMessageListeners()
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
        loadBackground()
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
        loadBackground()
        const resp = await invoke({ action: 'fetchSupportedStores' })
        expect(calls).toBe(2)
        expect(resp).toEqual({ supported: [{ domain: 'example.com' }] })
    })

    it('when the retry also dies, the reply carries the error in-band (consumers treat it as failure, not "no stores")', async () => {
        globalThis.fetch = () =>
            Promise.reject(new DOMException('signal is aborted', 'AbortError'))
        loadBackground()
        const resp = await invoke({ action: 'fetchSupportedStores' })
        expect(resp.error).toMatch(/abort/i)
    })
})
