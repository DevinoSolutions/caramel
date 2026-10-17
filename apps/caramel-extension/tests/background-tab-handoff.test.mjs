import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * background.js — the per-tab handoffs (tab-handoff.js). The tab and the site
 * a record belongs to are read off the message's SENDER, which the browser
 * fills in; anything the message says about them is ignored.
 */

let handler
let sessionData
let onRemoved
let onReplaced
let localData

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
    const area = data => ({
        get: (keys, cb) =>
            cb(Object.fromEntries([].concat(keys).map(k => [k, data()[k]]))),
        set: (items, cb) => {
            Object.assign(data(), items)
            cb?.()
        },
        remove: (keys, cb) => {
            for (const k of [].concat(keys)) delete data()[k]
            cb?.()
        },
    })
    localData = {}
    const syncData = {}
    stub.storage.local = area(() => localData)
    stub.storage.sync = area(() => syncData)
    stub.storage.session = area(() => sessionData)
    stub.runtime.lastError = undefined
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    stub.tabs.onRemoved.addListener = fn => {
        onRemoved = fn
    }
    stub.tabs.onReplaced.addListener = fn => {
        onReplaced = fn
    }
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

const SHOP = {
    tab: { id: 7, url: 'https://shop.test/cart' },
    url: 'https://shop.test/cart',
    frameId: 0,
}
const send = (message, sender = SHOP) =>
    new Promise(resolve =>
        handler({ action: 'tabHandoff', ...message }, sender, resolve),
    )

beforeEach(async () => {
    sessionData = {}
    onRemoved = null
    onReplaced = null
    globalThis.fetch = async url => {
        throw new Error(`unexpected fetch ${url}`)
    }
    vi.resetModules()
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
})

describe('tabHandoff', () => {
    it('holds a record for the next document of the tab, in session storage', async () => {
        const value = { code: 'SAVE10', id: 'c1', prices: [50] }

        expect(await send({ op: 'set', key: 'pending_submit', value })).toEqual(
            {
                saved: 'saved',
            },
        )
        expect(Object.keys(sessionData)).toHaveLength(1)
        expect(await send({ op: 'take', key: 'pending_submit' })).toEqual({
            value,
        })
        expect(await send({ op: 'take', key: 'pending_submit' })).toEqual({
            value: null,
        })
    })

    it('files the record under the sender, whatever the message claims', async () => {
        await send({
            op: 'set',
            key: 'pending_submit',
            value: { code: 'SAVE10' },
            tabId: 99,
            origin: 'https://elsewhere.test',
            domain: 'elsewhere.test',
        })

        const elsewhere = {
            tab: { id: 99, url: 'https://elsewhere.test/cart' },
            url: 'https://elsewhere.test/cart',
            frameId: 0,
        }
        expect(
            await send({ op: 'take', key: 'pending_submit' }, elsewhere),
        ).toEqual({ value: null })
        expect(await send({ op: 'take', key: 'pending_submit' })).toEqual({
            value: { code: 'SAVE10' },
        })
    })

    it('never answers another tab or another site', async () => {
        await send({ op: 'set', key: 'applied', value: { code: 'SAVE10' } })

        const otherTab = { ...SHOP, tab: { id: 8, url: SHOP.url } }
        const otherSite = {
            tab: { id: 7, url: 'https://other.test/' },
            url: 'https://other.test/',
            frameId: 0,
        }
        expect(await send({ op: 'take', key: 'applied' }, otherTab)).toEqual({
            value: null,
        })
        expect(await send({ op: 'take', key: 'applied' }, otherSite)).toEqual({
            value: null,
        })
        expect(await send({ op: 'take', key: 'applied' })).toEqual({
            value: { code: 'SAVE10' },
        })
    })

    it('answers nothing to a sender with no tab', async () => {
        // The popup and other extension pages have no tab to hand off in.
        const popup = { url: 'chrome-extension://id/popup.html' }

        expect(
            await send({ op: 'set', key: 'run', value: { hops: 0 } }, popup),
        ).toEqual({ error: 'no tab' })
        expect(sessionData).toEqual({})
    })

    it('refuses a kind it does not know', async () => {
        expect(
            await send({ op: 'set', key: 'unknown_kind', value: {} }),
        ).toEqual({ saved: 'refused' })
        expect(await send({ op: 'drop', key: 'run' })).toEqual({
            error: 'unknown op',
        })
    })

    it('forgets a tab when it closes', async () => {
        await send({ op: 'set', key: 'run', value: { hops: 1 } })
        expect(onRemoved).toBeTypeOf('function')

        onRemoved(7)
        expect(await send({ op: 'get', key: 'run' })).toEqual({ value: null })
    })

    it('answers only the top document of the tab', async () => {
        // An iframe the store embeds (an ad, a payment widget from another
        // site, or one on the store's own origin) shares the tab id.
        const frame = { ...SHOP, frameId: 3 }
        const unknownFrame = { tab: SHOP.tab, url: SHOP.url }

        expect(
            await send(
                { op: 'set', key: 'run', value: { hops: 0, t: 1 } },
                frame,
            ),
        ).toEqual({ error: 'not the top document' })
        expect(
            await send(
                { op: 'set', key: 'run', value: { hops: 0, t: 1 } },
                unknownFrame,
            ),
        ).toEqual({ error: 'not the top document' })
        expect(sessionData).toEqual({})

        await send({ op: 'set', key: 'run', value: { hops: 0, t: 1 } })
        expect(await send({ op: 'take', key: 'run' }, frame)).toEqual({
            error: 'not the top document',
        })
        expect(await send({ op: 'get', key: 'run' })).toEqual({
            value: { hops: 0, t: 1 },
        })
    })

    it('answers only the live document where the browser says which it is', async () => {
        // A prerendered or cached page of the same tab is not the one the
        // shopper sees; Chrome names it in documentLifecycle.
        for (const documentLifecycle of [
            'prerender',
            'cached',
            'pending_deletion',
        ])
            expect(
                await send(
                    { op: 'set', key: 'run', value: { hops: 0, t: 1 } },
                    { ...SHOP, documentLifecycle },
                ),
            ).toEqual({ error: 'not the live document' })
        expect(sessionData).toEqual({})

        expect(
            await send(
                { op: 'set', key: 'run', value: { hops: 0, t: 1 } },
                { ...SHOP, documentLifecycle: 'active' },
            ),
        ).toEqual({ saved: 'saved' })
    })

    it('forgets the tab a prerendered page replaces', async () => {
        await send({ op: 'set', key: 'run', value: { hops: 1, t: 1 } })
        expect(onReplaced).toBeTypeOf('function')

        // Chrome swaps tab 7 for tab 12. Nothing moves to the new id: the
        // page that arrives there starts no chain of its own.
        onReplaced(12, 7)
        await new Promise(r => setTimeout(r, 0))
        expect(await send({ op: 'get', key: 'run' })).toEqual({ value: null })
        expect(sessionData).toEqual({})
    })

    it('replaces a record only over the one the page read', async () => {
        const read = { hops: 1, t: 5 }
        await send({ op: 'set', key: 'run', value: read })

        expect(
            await send({
                op: 'replace',
                key: 'run',
                value: { hops: 2, t: 5 },
                expected: read,
            }),
        ).toEqual({ saved: 'saved' })
        // The page read hops 1; the record is now hops 2.
        expect(
            await send({
                op: 'replace',
                key: 'run',
                value: { hops: 2, t: 5 },
                expected: read,
            }),
        ).toEqual({ saved: 'changed' })
        expect(
            await send({ op: 'replace', key: 'applied', value: { a: 1 } }),
        ).toEqual({ saved: 'absent' })
        expect(await send({ op: 'get', key: 'run' })).toEqual({
            value: { hops: 2, t: 5 },
        })
    })

    it('writes down a refused record', async () => {
        await send({
            op: 'set',
            key: 'pending_submit',
            value: { big: 'x'.repeat(5000) },
        })
        expect(localData.caramel_bg_errors).toEqual([
            expect.objectContaining({
                where: 'tabHandoffRefused',
                message: 'set pending_submit',
            }),
        ])
    })
})
