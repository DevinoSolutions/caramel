import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * background.js — the coupon-box pick request. The content script hands over
 * a page outline; THIS reads the couponBoxLlm flag again, posts the outline to
 * the server, and passes back its answer or { error } for a refusal.
 */

let handler
let fetchCalls
let responses // queue of fetch results, consumed in order
let sessionData

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
    const localData = {}
    const syncData = {}
    stub.storage.local = area(() => localData)
    stub.storage.sync = area(() => syncData)
    stub.storage.session = area(() => sessionData)
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

const ok = body => ({ ok: true, status: 200, json: async () => body })
const features = llm =>
    ok({
        shopperCodeCapture: false,
        couponBoxDiscovery: true,
        couponBoxLlm: llm,
    })

function invoke(message) {
    return new Promise(resolve => handler(message, {}, resolve))
}

const PICK = {
    action: 'couponBoxPick',
    domain: 'shop.test',
    outline: '- form:\n  - [0] textbox "Promo code"\n  - [1] button "Apply"',
}
const pickCalls = () =>
    fetchCalls.filter(c => c.url.includes('extension/coupon-box-pick'))

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

describe('couponBoxLlmEnabled', () => {
    it('answers the server flag', async () => {
        responses.push(features(true))

        expect(await invoke({ action: 'couponBoxLlmEnabled' })).toEqual({
            enabled: true,
        })
    })

    it('an app that predates the flag is off', async () => {
        responses.push(ok({ shopperCodeCapture: true }))

        expect(await invoke({ action: 'couponBoxLlmEnabled' })).toEqual({
            enabled: false,
        })
    })

    it('a failed features read is off', async () => {
        responses.push(new TypeError('Failed to fetch'))

        expect(await invoke({ action: 'couponBoxLlmEnabled' })).toEqual({
            enabled: false,
        })
    })
})

describe('couponBoxPick', () => {
    it('flag off: nothing is posted', async () => {
        responses.push(features(false))

        expect(await invoke(PICK)).toEqual({ error: 'disabled' })
        expect(pickCalls()).toHaveLength(0)
    })

    it('posts the domain and outline as JSON and passes the answer back', async () => {
        const answer = {
            outcome: 'box',
            input: 0,
            button: 1,
            toggle: null,
            confidence: 90,
            why: 'labelled field',
            cached: false,
        }
        responses.push(features(true), ok(answer))

        expect(await invoke(PICK)).toEqual(answer)
        const [call] = pickCalls()
        expect(call.opts.method).toBe('POST')
        expect(call.opts.headers['Content-Type']).toBe('application/json')
        expect(JSON.parse(call.opts.body)).toEqual({
            domain: PICK.domain,
            outline: PICK.outline,
        })
    })

    it('a refusal is passed back as an error, never retried', async () => {
        responses.push(features(true), {
            ok: false,
            status: 429,
            json: async () => ({ error: 'Too many requests.' }),
        })

        expect(await invoke(PICK)).toEqual({ error: 'HTTP 429' })
        expect(pickCalls()).toHaveLength(1)
    })

    it('a network failure is answered as an error', async () => {
        responses.push(features(true), new TypeError('Failed to fetch'))

        expect(await invoke(PICK)).toEqual({
            error: 'TypeError: Failed to fetch',
        })
        expect(pickCalls()).toHaveLength(1)
    })
})
