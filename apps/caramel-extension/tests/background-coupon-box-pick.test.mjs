import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COUPON_BOX_PICK_DEADLINE_MS } from '../background.js'

/**
 * background.js — the coupon-box pick request. The content script hands over
 * a page outline; THIS reads the couponBoxLlm flag again, posts the outline to
 * the server, and passes back its answer or { error } for a refusal.
 */

let handler
let fetchCalls
let responses // queue of fetch results, consumed in order
let sessionData
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
            // This build reads a learned answer (selectors under `box`).
            acceptsLearned: true,
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

describe('couponBoxPick: one deadline for the whole ask', () => {
    let clock
    let timeouts
    let featuresCost // ms the features read takes off the deadline

    beforeEach(() => {
        clock = 1_000_000
        featuresCost = 0
        vi.spyOn(Date, 'now').mockImplementation(() => clock)
        // Every abort timer fetchWithTimeout arms, in order.
        timeouts = []
        const realSetTimeout = globalThis.setTimeout
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
            timeouts.push(ms)
            return realSetTimeout(fn, 60_000)
        })
        const realFetch = globalThis.fetch
        globalThis.fetch = async (url, opts) => {
            if (String(url).includes('extension/features'))
                clock += featuresCost
            return realFetch(url, opts)
        }
    })
    const pickTimeout = () => timeouts.at(-1)

    afterEach(() => vi.restoreAllMocks())

    it('a quick flag read leaves the request its 23s cap, past the 20s the server gives the model', async () => {
        responses.push(features(true), ok({ outcome: 'no_box' }))

        await invoke(PICK)

        expect(pickCalls()).toHaveLength(1)
        expect(pickTimeout()).toBe(23000)
    })

    it('a slow features refetch is taken off the request', async () => {
        featuresCost = 9000
        responses.push(features(true), ok({ outcome: 'no_box' }))

        await invoke(PICK)

        expect(pickCalls()).toHaveLength(1)
        expect(pickTimeout()).toBe(COUPON_BOX_PICK_DEADLINE_MS - 9000)
    })

    it('under 3s left: no request is sent', async () => {
        featuresCost = COUPON_BOX_PICK_DEADLINE_MS - 2500
        responses.push(features(true))

        expect(await invoke(PICK)).toEqual({ error: 'out of time' })
        expect(pickCalls()).toHaveLength(0)
    })

    it('exactly 3s left: the request still goes, with those 3s', async () => {
        featuresCost = COUPON_BOX_PICK_DEADLINE_MS - 3000
        responses.push(features(true), ok({ outcome: 'no_box' }))

        await invoke(PICK)

        expect(pickCalls()).toHaveLength(1)
        expect(pickTimeout()).toBe(3000)
    })
})

describe('couponBoxLlmEnabled: the pick mode', () => {
    it('passes the server mode on beside the flag', async () => {
        responses.push(
            ok({
                shopperCodeCapture: false,
                couponBoxDiscovery: true,
                couponBoxLlm: true,
                couponBoxPickMode: 'llm_only',
            }),
        )

        expect(await invoke({ action: 'couponBoxLlmEnabled' })).toEqual({
            enabled: true,
            mode: 'llm_only',
        })
    })

    it('a failed features read answers no mode at all (rules_first)', async () => {
        responses.push(new TypeError('Failed to fetch'))

        expect(await invoke({ action: 'couponBoxLlmEnabled' })).toStrictEqual({
            enabled: false,
        })
    })
})

describe('couponBoxLearned', () => {
    const LEARNED = {
        action: 'couponBoxLearned',
        domain: 'shop.test',
        box: {
            input: 'input[name="coupon"]',
            apply: 'button#apply',
            toggle: null,
            enterOnly: false,
        },
        source: 'rules',
        evidence: 'total_dropped',
        outcome: 'confirmed',
    }
    const learnedCalls = () =>
        fetchCalls.filter(c => c.url.includes('extension/coupon-box-learned'))
    const IID = '0b6f4c1e-8d2a-4f3b-9c5d-7e1a2b3c4d5e'
    beforeEach(() => {
        localData.caramel_install_attribution = { iid: IID }
    })

    it('flag off: nothing is posted, and the answer says so', async () => {
        responses.push(features(false))

        expect(await invoke(LEARNED)).toEqual({ skipped: 'disabled' })
        expect(learnedCalls()).toHaveLength(0)
    })

    it('posts the install id, the selectors and the outcome, nothing else', async () => {
        responses.push(features(true), ok({ recorded: true }))

        expect(await invoke(LEARNED)).toEqual({
            ok: true,
            recorded: true,
            reason: null,
        })
        const [call] = learnedCalls()
        expect(call.opts.method).toBe('POST')
        expect(JSON.parse(call.opts.body)).toEqual({
            installId: IID,
            domain: 'shop.test',
            box: LEARNED.box,
            source: 'rules',
            evidence: 'total_dropped',
            outcome: 'confirmed',
        })
    })

    it('a report the server declined to record says why', async () => {
        responses.push(
            features(true),
            ok({ recorded: false, reason: 'served_config' }),
        )

        expect(await invoke(LEARNED)).toEqual({
            ok: true,
            recorded: false,
            reason: 'served_config',
        })
    })

    it('an install with no install id posts nothing, and says so', async () => {
        delete localData.caramel_install_attribution
        responses.push(features(true))

        expect(await invoke(LEARNED)).toEqual({ skipped: 'no install id' })
        expect(learnedCalls()).toHaveLength(0)
    })

    it('a refusal is answered with its status, a network failure as an error', async () => {
        responses.push(features(true), {
            ok: false,
            status: 429,
            json: async () => ({}),
        })
        expect(await invoke(LEARNED)).toEqual({ error: 'HTTP 429' })

        responses.push(new TypeError('Failed to fetch'))
        expect(await invoke(LEARNED)).toEqual({
            error: 'TypeError: Failed to fetch',
        })
    })
})
