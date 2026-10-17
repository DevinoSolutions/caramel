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
let onRemoved
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
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

const ok = body => ({ ok: true, status: 200, json: async () => body })
const features = (llm, learned) =>
    ok({
        shopperCodeCapture: false,
        couponBoxDiscovery: true,
        couponBoxLlm: llm,
        ...(learned === undefined ? {} : { couponBoxLearned: learned }),
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
    onRemoved = null
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
        // No learned-box flag: the request does not ask for a learned answer.
        expect(JSON.parse(call.opts.body)).toEqual({
            domain: PICK.domain,
            outline: PICK.outline,
        })
    })

    it('asks for a learned answer only while the learned-box flag is on', async () => {
        responses.push(features(true, true), ok({ outcome: 'no_box' }))
        await invoke(PICK)
        expect(JSON.parse(pickCalls()[0].opts.body)).toEqual({
            domain: PICK.domain,
            outline: PICK.outline,
            acceptsLearned: true,
        })
    })

    it('a store with a served config never asks for a learned answer', async () => {
        responses.push(features(true, true), ok({ outcome: 'no_box' }))
        await invoke({ ...PICK, served: true })
        expect(JSON.parse(pickCalls()[0].opts.body)).not.toHaveProperty(
            'acceptsLearned',
        )
    })

    it('a learned-box flag that is not a literal true does not ask', async () => {
        responses.push(
            ok({
                shopperCodeCapture: false,
                couponBoxDiscovery: true,
                couponBoxLlm: true,
                couponBoxLearned: 'true',
            }),
            ok({ outcome: 'no_box' }),
        )
        await invoke(PICK)
        expect(JSON.parse(pickCalls()[0].opts.body)).not.toHaveProperty(
            'acceptsLearned',
        )
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
    // The tab the message came from: the one store it may speak for.
    const SHOP = { tab: { id: 7, url: 'https://shop.test/cart' } }
    const from = (message, sender = SHOP) =>
        new Promise(resolve => handler(message, sender, resolve))
    const BOX = {
        input: 'input[name="coupon"]',
        apply: 'button#apply',
        toggle: null,
        enterOnly: false,
    }
    const LEARNED = {
        action: 'couponBoxLearned',
        // Never read: the store is the sender's own host.
        domain: 'victim.test',
        box: BOX,
        source: 'rules',
        evidence: 'total_dropped',
        outcome: 'confirmed',
        report: true,
    }
    const learnedCalls = () =>
        fetchCalls.filter(c => c.url.includes('extension/coupon-box-learned'))
    const memory = () => localData.caramel_learned_boxes || {}
    const IID = '0b6f4c1e-8d2a-4f3b-9c5d-7e1a2b3c4d5e'
    beforeEach(() => {
        localData.caramel_install_attribution = { iid: IID }
    })

    for (const [what, flags] of [
        ['a server with no learned-box flag', [true, undefined]],
        ['the learned-box flag off', [true, false]],
    ])
        it(`${what}: nothing is remembered or posted, and the answer says so`, async () => {
            responses.push(features(...flags))

            expect(await from(LEARNED)).toEqual({ skipped: 'disabled' })
            expect(memory()).toEqual({})
            expect(learnedCalls()).toHaveLength(0)
        })

    it('the pick flag off: remembered here, never posted', async () => {
        responses.push(features(false, true))

        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            skipped: 'disabled',
        })
        expect(Object.keys(memory())).toEqual(['shop.test'])
        expect(learnedCalls()).toHaveLength(0)
    })

    it("posts for the sender's own host, never the domain the message names", async () => {
        responses.push(features(true, true), ok({ recorded: true }))

        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            ok: true,
            recorded: true,
            reason: null,
        })
        const [call] = learnedCalls()
        expect(call.opts.method).toBe('POST')
        expect(JSON.parse(call.opts.body)).toEqual({
            installId: IID,
            domain: 'shop.test',
            box: BOX,
            source: 'rules',
            evidence: 'total_dropped',
            outcome: 'confirmed',
        })
        expect(Object.keys(memory())).toEqual(['shop.test'])
    })

    it('a use that is not reported is remembered only', async () => {
        responses.push(features(true, true))

        expect(
            await from({ ...LEARNED, outcome: 'failed', report: false }),
        ).toEqual({ saved: 'kept' })
        expect(learnedCalls()).toHaveLength(0)
    })

    for (const [what, change] of [
        ['a 100 kB selector', { box: { ...BOX, input: 'a'.repeat(100000) } }],
        [
            'a selector outside the grammar',
            { box: { ...BOX, apply: 'button:has(svg)' } },
        ],
        ['a source the finder never writes', { source: 'page' }],
        ['no box at all', { box: null }],
    ])
        it(`${what} is refused: nothing remembered, nothing posted`, async () => {
            responses.push(features(true, true))

            expect(await from({ ...LEARNED, ...change })).toEqual({
                saved: 'refused',
            })
            expect(memory()).toEqual({})
            expect(learnedCalls()).toHaveLength(0)
        })

    it('evidence the finder never writes is posted as none', async () => {
        responses.push(features(true, true), ok({ recorded: true }))

        await from({ ...LEARNED, evidence: 'page_said_so' })
        expect(JSON.parse(learnedCalls()[0].opts.body).evidence).toBeNull()
    })

    it('a message from no tab is skipped', async () => {
        responses.push(features(true, true))

        expect(await from(LEARNED, {})).toEqual({ skipped: 'no tab' })
        expect(memory()).toEqual({})
    })

    it('two tabs answering at once keep both stores', async () => {
        responses.push(features(true, true))
        const other = { tab: { id: 8, url: 'https://other.test/bag' } }

        await Promise.all([
            from({ ...LEARNED, report: false }),
            from({ ...LEARNED, report: false }, other),
        ])

        expect(Object.keys(memory()).sort()).toEqual([
            'other.test',
            'shop.test',
        ])
    })

    it('a report the server declined to record says why', async () => {
        responses.push(
            features(true, true),
            ok({ recorded: false, reason: 'served_config' }),
        )

        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            ok: true,
            recorded: false,
            reason: 'served_config',
        })
    })

    it('an install with no install id posts nothing, and says so', async () => {
        delete localData.caramel_install_attribution
        responses.push(features(true, true))

        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            skipped: 'no install id',
        })
        expect(learnedCalls()).toHaveLength(0)
    })

    it('a refusal is answered with its status, a network failure as an error', async () => {
        responses.push(features(true, true), {
            ok: false,
            status: 429,
            json: async () => ({}),
        })
        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            error: 'HTTP 429',
        })

        responses.push(new TypeError('Failed to fetch'))
        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            error: 'TypeError: Failed to fetch',
        })
    })

    it('a box the server refuses (400) is posted once, never again, and stays remembered', async () => {
        responses.push(features(true, true), {
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid' }),
        })

        expect(await from(LEARNED)).toEqual({
            saved: 'saved',
            error: 'HTTP 400',
        })
        // Give any retry the time to show itself.
        await new Promise(r => setTimeout(r, 30))
        expect(learnedCalls()).toHaveLength(1)
        expect(Object.keys(memory())).toEqual(['shop.test'])
    })

    for (const [what, box] of [
        ['an apply that places the order', { ...BOX, apply: '#place-order' }],
        ['a toggle that removes', { ...BOX, toggle: 'button.remove-coupon' }],
        ['an email in the input', { ...BOX, input: 'input[data-e="a@b.com"]' }],
        ['a long number', { ...BOX, apply: 'button#apply-1234567' }],
    ])
        it(`${what}: refused here, never remembered nor posted`, async () => {
            responses.push(features(true, true))

            expect(await from({ ...LEARNED, box })).toEqual({
                saved: 'refused',
            })
            expect(memory()).toEqual({})
            expect(learnedCalls()).toHaveLength(0)
        })
})

describe('couponBoxLearnedBox', () => {
    const SAVED = {
        v: 1,
        input: 'input#promo',
        apply: 'button#apply',
        toggle: null,
        enterOnly: false,
        source: 'llm',
        confirmedAt: 1,
        failures: 0,
    }
    const from = (url, id = 7) =>
        new Promise(resolve =>
            handler(
                { action: 'couponBoxLearnedBox', domain: 'shop.test' },
                { tab: { id, url } },
                resolve,
            ),
        )
    beforeEach(() => {
        localData.caramel_learned_boxes = {
            'shop.test': SAVED,
            'forged.test': { ...SAVED, input: 'x'.repeat(5000) },
        }
    })

    it("answers the box remembered for the sender's own host only", async () => {
        responses.push(features(true, true))

        expect(await from('https://shop.test/cart')).toEqual({ box: SAVED })
        expect(await from('https://other.test/cart')).toEqual({ box: null })
    })

    it('an entry the memory could not have written is never answered', async () => {
        responses.push(features(true, true))

        expect(await from('https://forged.test/cart')).toEqual({ box: null })
    })

    for (const [what, learned] of [
        ['no learned-box flag', undefined],
        ['the learned-box flag off', false],
    ])
        it(`${what}: no box, though the finder is on`, async () => {
            responses.push(features(true, learned))

            expect(await from('https://shop.test/cart')).toEqual({ box: null })
        })
})

describe('the box a run holds across a reload', () => {
    const L = {
        box: { input: 'input#promo', apply: null, toggle: null },
        source: 'rules',
        learned: false,
    }
    const send = (action, url, id = 7, extra = {}) =>
        new Promise(resolve =>
            handler({ action, ...extra }, { tab: { id, url } }, resolve),
        )
    const hold = (url, id) => send('couponBoxLearnHold', url, id, { l: L })
    const take = (url, id) => send('couponBoxLearnTake', url, id)
    afterEach(() => vi.restoreAllMocks())

    it('is taken once, by the same tab on the same host', async () => {
        responses.push(features(true, true))
        await hold('https://shop.test/cart')

        expect(await take('https://shop.test/cart?x=1')).toEqual({
            l: { box: L.box, source: 'rules', learned: false },
        })
        expect(await take('https://shop.test/cart')).toEqual({ l: null })
    })

    it('another host, or another tab, takes nothing', async () => {
        responses.push(features(true, true))
        await hold('https://shop.test/cart')

        expect(await take('https://victim.test/cart')).toEqual({ l: null })
        await hold('https://shop.test/cart')
        expect(await take('https://shop.test/cart', 9)).toEqual({ l: null })
    })

    it('a page that held nothing takes nothing', async () => {
        responses.push(features(true, true))

        expect(await take('https://shop.test/cart')).toEqual({ l: null })
    })

    it('is not taken once its two minutes are up', async () => {
        responses.push(features(true, true))
        await hold('https://shop.test/cart')
        const later = Date.now() + 2 * 60 * 1000 + 1
        vi.spyOn(Date, 'now').mockReturnValue(later)

        expect(await take('https://shop.test/cart')).toEqual({ l: null })
    })

    it('is forgotten when its tab closes', async () => {
        responses.push(features(true, true))
        await hold('https://shop.test/cart')
        expect(onRemoved).toBeTypeOf('function')

        onRemoved(7)
        expect(await take('https://shop.test/cart')).toEqual({ l: null })
    })

    it('nothing is held while remembering is off', async () => {
        responses.push(features(true, false))

        expect(await hold('https://shop.test/cart')).toEqual({ held: false })
        expect(await take('https://shop.test/cart')).toEqual({ l: null })
    })
})
