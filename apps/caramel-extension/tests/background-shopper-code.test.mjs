import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * background.js `submitShopperCode` — the gate between a captured code and the
 * network. The content script is deliberately dumb; THIS decides whether the
 * code may leave the browser (signed in + server flag on) and maps the
 * server's answers onto "skipped" (expected, quiet) versus "error" (real,
 * logged).
 */

let handler
let fetchCalls
let responses // queue of fetch results, consumed in order
let localData
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
    stub.storage.local = area(() => localData)
    stub.storage.sync = area(() => ({}))
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
const refused = (status, body) => ({
    ok: false,
    status,
    json: async () => body,
})
const features = flag => ok({ shopperCodeCapture: flag })

function invoke(message) {
    return new Promise(resolve => handler(message, {}, resolve))
}

const CAPTURE = {
    action: 'submitShopperCode',
    site: 'ebay.com',
    code: 'SAVE10',
}

const submitCalls = () =>
    fetchCalls.filter(c => c.url.includes('coupons/submit'))
const featureCalls = () =>
    fetchCalls.filter(c => c.url.includes('extension/features'))

beforeEach(async () => {
    fetchCalls = []
    responses = []
    localData = { token: 'tok-123' }
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

describe('submitShopperCode — gates', () => {
    it('signed out: skipped, and nothing is fetched at all', async () => {
        localData = {}

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'signed-out' })
        expect(fetchCalls).toEqual([])
    })

    it('flag off: skipped, and the flag is cached (one features fetch)', async () => {
        responses.push(features(false))

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })

        expect(featureCalls()).toHaveLength(1)
        expect(submitCalls()).toHaveLength(0)
        // Survives a worker restart via storage.session.
        expect(sessionData.caramel_features.shopperCodeCapture).toBe(false)
    })

    it('a flag fetch that fails is a real error, not a quiet skip', async () => {
        responses.push(refused(500, null))

        const resp = await invoke(CAPTURE)

        expect(resp.error).toMatch(/features HTTP 500/)
        expect(localData.caramel_bg_errors?.[0]?.where).toBe(
            'submitShopperCode',
        )
    })
})

describe('submitShopperCode — the submit and its answers', () => {
    it('flag on: POSTs {site, code, source:"checkout"} with the bearer', async () => {
        responses.push(
            features(true),
            ok({
                couponId: '900000000000000001',
                created: true,
                status: 'worked',
            }),
        )

        const resp = await invoke(CAPTURE)

        expect(resp).toEqual({
            couponId: '900000000000000001',
            created: true,
            status: 'worked',
        })
        const [call] = submitCalls()
        expect(call.opts.method).toBe('POST')
        expect(call.opts.headers.Authorization).toBe('Bearer tok-123')
        expect(JSON.parse(call.opts.body)).toEqual({
            site: 'ebay.com',
            code: 'SAVE10',
            source: 'checkout',
        })
        // The flag fetch is anonymous: nothing user-scoped in the answer.
        expect(featureCalls()[0].opts?.headers?.Authorization).toBeUndefined()
    })

    it('403 capture-disabled: skipped, and the cached flag is dropped', async () => {
        responses.push(
            features(true),
            refused(403, { error: 'capture-disabled' }),
            features(true),
            ok({ couponId: '9', created: false, status: 'worked' }),
        )

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
        await invoke(CAPTURE)

        expect(featureCalls()).toHaveLength(2)
    })

    it.each([
        [422, { error: 'invalid-code' }, 'invalid-code'],
        [422, { error: 'not-a-store' }, 'not-a-store'],
        [429, { error: 'daily-limit' }, 'daily-limit'],
        [429, null, 'rate-limited'],
        [401, null, 'signed-out'],
    ])(
        '%s %j is a quiet skip (%s), never an error',
        async (status, body, skipped) => {
            responses.push(features(true), refused(status, body))

            expect(await invoke(CAPTURE)).toEqual({ skipped })
            expect(localData.caramel_bg_errors).toBeUndefined()
        },
    )

    it('500 is a real failure: answered as error and logged', async () => {
        responses.push(features(true), refused(500, null))

        const resp = await invoke(CAPTURE)

        expect(resp.error).toMatch(/submit HTTP 500/)
        expect(localData.caramel_bg_errors[0].where).toBe('submitShopperCode')
    })

    it('the extension-only 403 is a real failure too, not a skip', async () => {
        responses.push(
            features(true),
            refused(403, { error: 'checkout-source-extension-only' }),
        )

        const resp = await invoke(CAPTURE)

        expect(resp.error).toMatch(/checkout-source-extension-only/)
        expect(localData.caramel_bg_errors).toHaveLength(1)
    })

    it('a network failure is answered as error and logged', async () => {
        responses.push(features(true), new Error('offline'))

        const resp = await invoke(CAPTURE)

        expect(resp.error).toMatch(/offline/)
        expect(localData.caramel_bg_errors).toHaveLength(1)
    })

    it('a malformed message is an error, not a silent drop', async () => {
        const resp = await invoke({ action: 'submitShopperCode', site: 1 })

        expect(resp.error).toMatch(/must be strings/)
    })
})
