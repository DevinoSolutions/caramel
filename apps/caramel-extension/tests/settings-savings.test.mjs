import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the caramel-base.js user-preference + savings-history helpers that
// the checkout prompt (UI-helpers.js insertCaramelPrompt), the apply flow
// (coupon-runner.js) and the popup all consume:
//   * caramelPromptAllowed — the ONE gate deciding whether the passive
//     checkout pill may appear (global toggle + per-site pause,
//     subdomains included).
//   * caramelRecordSaving/caramelGetSavings — measured-wins-only history,
//     newest first, capped.
// Storage is faked with a real in-memory map (a permissive stub's default
// empty storage isn't enough here — these tests assert persisted shapes).
//
// The old harness re-eval'd caramel-base.js per test; vi.resetModules() + a
// dynamic import is that same freshness in the ESM world (module state like
// the settings cache must not leak between tests). The re-init works only
// because `window.currentBrowser` is cleared first: caramel-base's re-resolve
// branch keys off it, and a fresh module registry would otherwise bind the
// PREVIOUS realm's browser handle (the once-latch the port fleet documented).
let helpers
let syncData
let localData

function installChromeStub() {
    const area = data => ({
        get: (_keys, cb) => cb({ ...data() }),
        set: (items, cb) => {
            Object.assign(data(), items)
            if (cb) cb()
        },
        remove: (keys, cb) => {
            for (const key of [].concat(keys)) delete data()[key]
            if (cb) cb()
        },
    })
    globalThis.chrome = {
        runtime: {
            id: 'test-ext-id',
            lastError: undefined,
            onMessage: { addListener: () => {} },
            sendMessage: () => {},
            getURL: p => p,
        },
        storage: {
            sync: area(() => syncData),
            local: area(() => localData),
        },
    }
}

beforeEach(async () => {
    syncData = {}
    localData = {}
    vi.resetModules()
    installChromeStub()
    window.currentBrowser = undefined
    const mod = await import('../caramel-base.js')
    mod.initCaramelBase()
    helpers = mod
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
