import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSource } from './_load.mjs'

// Pins the toolbar badge: per-tab coupon count for the active site,
// sourced from GET /api/coupons?site=<domain>&limit=1 (only `total` is
// read), cached per domain, cleared on non-http tabs, capped at "99+".
let updateBadgeForTab
let badgeCalls
let fetchCalls

beforeAll(() => {
    globalThis.fetch = async url => {
        fetchCalls.push(String(url))
        return {
            ok: true,
            status: 200,
            json: async () => ({ coupons: [], total: 7 }),
        }
    }
    ;({ updateBadgeForTab } = loadExtensionSource('background.js', [
        'updateBadgeForTab',
    ]))
})

beforeEach(() => {
    badgeCalls = []
    fetchCalls = []
    // background.js binds `currentBrowser` to the chrome stub installed by
    // loadExtensionSource — reach it via globalThis.chrome.
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
