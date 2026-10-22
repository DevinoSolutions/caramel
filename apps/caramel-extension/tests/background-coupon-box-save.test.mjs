import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * background.js — saving an auto-detected coupon box as the store's config.
 * The finder hands over the box it found once a code typed into it took money
 * off the total; THIS reads the couponBoxSave flag, takes the host from the
 * sender's tab (never from the message), and posts the box's selectors once
 * per host per browser session. A box with no order total is never sent: the
 * next shopper's run reads the saving there.
 */

let handler
let fetchCalls
let responses // queue of fetch results, consumed in order
let sessionData
let localData

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
    localData = {}
    const syncData = {}
    stub.storage.local = area(() => localData)
    stub.storage.sync = area(() => syncData)
    stub.storage.session = area(() => sessionData)
    stub.runtime.lastError = undefined
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    stub.tabs.onRemoved.addListener = () => {}
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

const ok = body => ({ ok: true, status: 200, json: async () => body })
const status = (code, body = {}) => ({
    ok: code < 400,
    status: code,
    json: async () => body,
})
const features = save =>
    ok({
        shopperCodeCapture: false,
        couponBoxDiscovery: true,
        couponBoxLlm: false,
        couponBoxSave: save,
    })

const BOX = {
    input: 'input#in',
    apply: 'button#btn',
    toggle: null,
    total: 'span#tot',
}
const TOP = { frameId: 0, tab: { id: 7, url: 'https://www.shop.test/cart' } }

function invoke(message, sender = TOP) {
    return new Promise(resolve => handler(message, sender, resolve))
}
const save = (box = BOX, sender) =>
    invoke({ action: 'couponBoxSave', box }, sender)
const saveCalls = () =>
    fetchCalls.filter(c => c.url.includes('extension/coupon-box-save'))

beforeEach(async () => {
    fetchCalls = []
    responses = []
    sessionData = {}
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        const next = responses.shift()
        if (next instanceof Error) throw next
        if (!next) throw new Error(`unexpected fetch ${url}`)
        return next
    }
    vi.resetModules()
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
})

describe('couponBoxSave', () => {
    it('posts the host from the tab and the box, once per host', async () => {
        responses.push(features(true), ok({ saved: true, store: 'shop.test' }))

        expect(await save()).toEqual({ saved: true, reason: null })
        expect(saveCalls()).toHaveLength(1)
        expect(saveCalls()[0].opts.method).toBe('POST')
        expect(JSON.parse(saveCalls()[0].opts.body)).toEqual({
            host: 'www.shop.test',
            box: BOX,
        })

        expect(await save()).toEqual({ skipped: 'already sent' })
        expect(saveCalls()).toHaveLength(1)
    })

    it('sends only the four selectors, nothing else the message carried', async () => {
        responses.push(features(true), ok({ saved: true }))

        await save({ ...BOX, code: 'SAVE20', amount: 20 })

        expect(Object.keys(JSON.parse(saveCalls()[0].opts.body).box)).toEqual([
            'input',
            'apply',
            'toggle',
            'total',
        ])
    })

    it('a box with no order total is never sent', async () => {
        expect(await save({ ...BOX, total: null })).toEqual({
            skipped: 'invalid box',
        })
        expect(fetchCalls).toHaveLength(0)
    })

    it('a box with no input is never sent', async () => {
        expect(await save({ ...BOX, input: null })).toEqual({
            skipped: 'invalid box',
        })
        expect(fetchCalls).toHaveLength(0)
    })

    it('a frame inside the page never saves', async () => {
        expect(await save(BOX, { ...TOP, frameId: 3 })).toEqual({
            skipped: 'not the top document',
        })
        expect(fetchCalls).toHaveLength(0)
    })

    it('flag off: nothing is posted', async () => {
        responses.push(features(false))

        expect(await save()).toEqual({ skipped: 'disabled' })
        expect(saveCalls()).toHaveLength(0)
    })

    it('a server error or a limit leaves the host free for the next win', async () => {
        responses.push(features(true), status(503))
        expect(await save()).toEqual({ error: 'HTTP 503' })

        responses.push(status(429))
        expect(await save()).toEqual({ error: 'HTTP 429' })

        responses.push(ok({ saved: true }))
        expect(await save()).toEqual({ saved: true, reason: null })
        expect(saveCalls()).toHaveLength(3)
    })

    it('a refusal (the store has a config) is final for the session', async () => {
        responses.push(
            features(true),
            status(409, { saved: false, reason: 'has_config' }),
        )

        expect(await save()).toEqual({ saved: false, reason: 'has_config' })
        expect(await save()).toEqual({ skipped: 'already sent' })
        expect(saveCalls()).toHaveLength(1)
    })
})
