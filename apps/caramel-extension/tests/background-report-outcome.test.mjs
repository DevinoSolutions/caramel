import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// background.js `reportOutcome` has two callers with opposite needs:
//   · the apply flow (coupon-runner.js) — fire-and-forget; a report must never
//     break checkout, so the answer is always `{ success: true }` and a failed
//     POST is only logged. A "worked" report also bumps the usage counter.
//   · the popup's "Did it work?" vote (issue #288) — sends `awaitResult`, the
//     shopper is waiting on the answer, so the REAL status comes back and a
//     failure is never reported as success. A vote is not an apply: no bump.
let handler

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
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
        stub.storage[area].remove = (_keys, cb) => cb?.()
    }
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

beforeAll(async () => {
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
})

const invoke = message =>
    new Promise(resolve => {
        handler(message, {}, resolve)
    })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('background reportOutcome', () => {
    let calls
    let status
    beforeEach(() => {
        calls = []
        status = 200
        globalThis.fetch = async (url, opts) => {
            calls.push({ url: String(url), body: opts?.body })
            if (status === 'network') throw new TypeError('network down')
            return { ok: status < 300, status, json: async () => ({}) }
        }
    })

    it('awaitResult: resolves success only once the server accepted the report', async () => {
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'worked',
            awaitResult: true,
        })
        expect(resp).toEqual({ success: true })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toMatch(/\/api\/coupons\/42\/report$/)
        expect(JSON.parse(calls[0].body).outcome).toBe('worked')
    })

    it('awaitResult: hands the real HTTP status back (429 stays distinguishable)', async () => {
        status = 429
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'failed',
            awaitResult: true,
        })
        expect(resp).toEqual({ error: 'HTTP 429', status: 429 })
    })

    it('awaitResult: a network failure comes back as an error, never as success', async () => {
        status = 'network'
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'worked',
            awaitResult: true,
        })
        expect(resp.success).toBeUndefined()
        expect(resp.error).toMatch(/network down/)
    })

    it('awaitResult: a worked VOTE does not bump the usage counter', async () => {
        await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'worked',
            awaitResult: true,
        })
        await flush()
        expect(calls.some(c => c.url.endsWith('coupons/increment'))).toBe(false)
    })

    // T-10427: the store's refusal is redacted before it leaves the browser,
    // with the server's rule: the shopper's other code goes, the code being
    // reported stays readable.
    it('redacts a code the store echoed in its refusal, keeping the reported code', async () => {
        await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'failed',
            storeReason: 'FALL18 cannot be combined with MYCODE5',
            code: 'FALL18',
        })
        await flush()
        const body = JSON.parse(calls[0].body)
        expect(body).toEqual({
            outcome: 'failed',
            storeReason: 'FALL18 cannot be combined with [code]',
        })
    })

    it('cuts a long refusal to the 200 characters the route accepts', async () => {
        await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'failed',
            storeReason: `This promotion has expired. ${'x'.repeat(400)}`,
            code: 'FALL18',
        })
        await flush()
        expect(JSON.parse(calls[0].body).storeReason).toHaveLength(200)
    })

    it('apply flow (no awaitResult): unchanged — answers success at once even if the POST fails', async () => {
        status = 500
        const resp = await invoke({
            action: 'reportOutcome',
            id: '42',
            outcome: 'worked',
        })
        expect(resp).toEqual({ success: true })
        await flush()
        // ...and a "worked" report still bumps the public usage counter.
        expect(calls.map(c => c.url.replace(/^.*\/api\//, ''))).toEqual([
            'coupons/42/report',
            'coupons/increment',
        ])
    })
})

describe('background classifyCart (T-10427)', () => {
    let calls
    beforeEach(() => {
        calls = []
        globalThis.fetch = async (url, opts) => {
            calls.push({ url: String(url), body: opts?.body })
            return { ok: true, status: 200, json: async () => ({}) }
        }
    })

    it('drops a discount row and redacts a code-shaped token before sending', async () => {
        await invoke({
            action: 'classifyCart',
            signals: {
                domain: 'shop.test',
                cart_items: ['Discount: SAVE10', 'Dell XPS13 Laptop', 'Widget'],
            },
        })
        expect(JSON.parse(calls[0].body)).toEqual({
            domain: 'shop.test',
            cart_items: ['Dell [code] Laptop', 'Widget'],
        })
    })

    it('sends signals with no cart rows as they are', async () => {
        await invoke({ action: 'classifyCart', signals: { domain: 'a.test' } })
        expect(JSON.parse(calls[0].body)).toEqual({ domain: 'a.test' })
    })
})
