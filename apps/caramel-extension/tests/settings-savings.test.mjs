import { beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSource } from './_load.mjs'

// Pins the caramel-base.js user-preference + savings-history helpers that
// the checkout prompt (UI-helpers.js insertCaramelPrompt), the apply flow
// (coupon-runner.js) and the popup all consume:
//   * caramelPromptAllowed — the ONE gate deciding whether the passive
//     checkout pill may appear (global toggle + per-site pause,
//     subdomains included).
//   * caramelRecordSaving/caramelGetSavings — measured-wins-only history,
//     newest first, capped.
// Storage is faked with a real in-memory map (the permissive stub's
// default empty storage isn't enough here — these tests assert persisted
// shapes).
let helpers
let syncData
let localData

beforeEach(() => {
    helpers = loadExtensionSource('caramel-base.js', [
        'caramelGetSettings',
        'caramelSetSettings',
        'caramelPromptAllowed',
        'caramelGetSavings',
        'caramelRecordSaving',
    ])
    syncData = {}
    localData = {}
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) =>
        cb({ ...syncData })
    globalThis.currentBrowser.storage.sync.set = (items, cb) => {
        Object.assign(syncData, items)
        if (cb) cb()
    }
    globalThis.currentBrowser.storage.local.get = (_keys, cb) =>
        cb({ ...localData })
    globalThis.currentBrowser.storage.local.set = (items, cb) => {
        Object.assign(localData, items)
        if (cb) cb()
    }
})

describe('caramel-base.js settings helpers', () => {
    it('defaults to auto-apply ON with no disabled sites, and savings sync OFF', async () => {
        // syncSavings false is the load-bearing half: it is consent to upload a
        // shopping record, so an absent key must read as "has not opted in".
        expect(await helpers.caramelGetSettings()).toEqual({
            autoApply: true,
            disabledSites: [],
            syncSavings: false,
        })
        expect(await helpers.caramelPromptAllowed('shop.example.com')).toBe(
            true,
        )
    })

    it('global auto-apply OFF blocks the prompt everywhere', async () => {
        await helpers.caramelSetSettings({ autoApply: false })
        expect(await helpers.caramelPromptAllowed('shop.example.com')).toBe(
            false,
        )
    })

    it('a paused site blocks its own host, its subdomains and its www twin — nothing else', async () => {
        await helpers.caramelSetSettings({ disabledSites: ['example.com'] })
        expect(await helpers.caramelPromptAllowed('example.com')).toBe(false)
        expect(await helpers.caramelPromptAllowed('www.example.com')).toBe(
            false,
        )
        expect(await helpers.caramelPromptAllowed('checkout.example.com')).toBe(
            false,
        )
        expect(await helpers.caramelPromptAllowed('notexample.com')).toBe(true)
        expect(await helpers.caramelPromptAllowed('other.com')).toBe(true)
    })

    it('caramelSetSettings merges patches instead of clobbering the other key', async () => {
        await helpers.caramelSetSettings({ disabledSites: ['a.com'] })
        await helpers.caramelSetSettings({ autoApply: false })
        expect(await helpers.caramelGetSettings()).toEqual({
            autoApply: false,
            disabledSites: ['a.com'],
            syncSavings: false,
        })
    })
})

describe('caramel-base.js savings history', () => {
    it('records measured wins newest-first with a normalized shape', async () => {
        await helpers.caramelRecordSaving({
            domain: 'a.com',
            code: 'FIRST',
            amount: 5.005,
            currency: 'USD',
        })
        await helpers.caramelRecordSaving({
            domain: 'b.com',
            code: 'SECOND',
            amount: 2,
            currency: 'EUR',
        })
        const list = await helpers.caramelGetSavings()
        expect(list).toHaveLength(2)
        expect(list[0]).toMatchObject({
            domain: 'b.com',
            code: 'SECOND',
            amount: 2,
            currency: 'EUR',
        })
        expect(list[1].amount).toBe(5.01) // rounded to cents
        expect(typeof list[0].t).toBe('number')
    })

    it('ignores unmeasured/zero/negative amounts — applied-but-unmeasured codes are not "savings"', async () => {
        await helpers.caramelRecordSaving({ domain: 'a.com', code: 'X' })
        await helpers.caramelRecordSaving({
            domain: 'a.com',
            code: 'Y',
            amount: 0,
        })
        await helpers.caramelRecordSaving({
            domain: 'a.com',
            code: 'Z',
            amount: -3,
        })
        expect(await helpers.caramelGetSavings()).toEqual([])
    })

    it('caps the history at 50 entries', async () => {
        for (let i = 0; i < 55; i++) {
            await helpers.caramelRecordSaving({
                domain: 'a.com',
                code: `C${i}`,
                amount: 1,
            })
        }
        const list = await helpers.caramelGetSavings()
        expect(list).toHaveLength(50)
        expect(list[0].code).toBe('C54') // newest kept
    })
})
