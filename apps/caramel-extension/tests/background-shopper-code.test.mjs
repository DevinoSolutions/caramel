import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
let syncData

const CONSENT_KEY = 'checkoutCodeSharingConsent'
const consent = choice => ({
    choice,
    at: '2026-10-06T12:00:00.000Z',
    promptVersion: 1,
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
    // Consent is accepted unless a test says otherwise: the gates below are the
    // subject of the consent describe, everything else assumes a yes.
    syncData = { [CONSENT_KEY]: consent('accepted') }
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        const next = responses.shift()
        if (next instanceof Error) throw next
        if (typeof next === 'function') return next()
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

    it('a cached "off" is only trusted for 30 minutes, a cached "on" for 6 hours', async () => {
        const t0 = 1_800_000_000_000
        const now = vi.spyOn(Date, 'now')
        now.mockReturnValue(t0)
        responses.push(features(false), features(true))

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
        // 29 minutes on: still the cached "off".
        now.mockReturnValue(t0 + 29 * 60 * 1000)
        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
        expect(featureCalls()).toHaveLength(1)

        // 31 minutes on: the "off" has expired and the owner's flip is seen.
        now.mockReturnValue(t0 + 31 * 60 * 1000)
        responses.push(
            ok({ couponId: '9', created: true, status: 'unverified' }),
        )
        expect((await invoke(CAPTURE)).couponId).toBe('9')
        expect(featureCalls()).toHaveLength(2)

        // The "on" survives well past 30 minutes (5h later: no refetch)...
        now.mockReturnValue(t0 + 31 * 60 * 1000 + 5 * 60 * 60 * 1000)
        responses.push(
            ok({ couponId: '9', created: false, status: 'unverified' }),
        )
        await invoke(CAPTURE)
        expect(featureCalls()).toHaveLength(2)

        // ...but not past 6 hours.
        now.mockReturnValue(t0 + 31 * 60 * 1000 + 7 * 60 * 60 * 1000)
        responses.push(
            features(true),
            ok({ couponId: '9', created: false, status: 'unverified' }),
        )
        await invoke(CAPTURE)
        expect(featureCalls()).toHaveLength(3)
        now.mockRestore()
    })

    it('concurrent captures share ONE in-flight features fetch', async () => {
        let release
        responses.push(
            () =>
                new Promise(resolve => {
                    release = () => resolve(features(false))
                }),
        )

        const first = invoke(CAPTURE)
        const second = invoke(CAPTURE)
        const third = invoke(CAPTURE)
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        release()

        expect(await Promise.all([first, second, third])).toEqual([
            { skipped: 'disabled' },
            { skipped: 'disabled' },
            { skipped: 'disabled' },
        ])
        expect(featureCalls()).toHaveLength(1)
    })

    it('a failed shared fetch is retried by the next caller (not cached as a failure)', async () => {
        responses.push(refused(500, null), features(false))

        expect((await invoke(CAPTURE)).error).toMatch(/features HTTP 500/)
        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
        expect(featureCalls()).toHaveLength(2)
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

describe('submitShopperCode — consent gate (owner rule 2026-10-06)', () => {
    it.each([
        ['no record', undefined],
        ['declined', consent('declined')],
        ['an unknown choice', { ...consent('accepted'), choice: 'maybe' }],
        [
            'another prompt version',
            { ...consent('accepted'), promptVersion: 2 },
        ],
        ['a malformed date', { ...consent('accepted'), at: 'soon' }],
        ['a bare true', true],
    ])(
        '%s: skipped as no-consent, and NOTHING is submitted',
        async (_label, record) => {
            if (record === undefined) delete syncData[CONSENT_KEY]
            else syncData[CONSENT_KEY] = record
            // A stale legacy opt-in must not count as consent.
            syncData.caramel_settings = { shareCheckoutCodes: true }
            responses.push(features(true))

            expect(await invoke(CAPTURE)).toEqual({ skipped: 'no-consent' })

            expect(submitCalls()).toHaveLength(0)
        },
    )

    it('accepted: submitted', async () => {
        responses.push(
            features(true),
            ok({ couponId: '9', created: true, status: 'unverified' }),
        )

        expect((await invoke(CAPTURE)).couponId).toBe('9')
        expect(submitCalls()).toHaveLength(1)
    })

    it('the consent gate runs AFTER sign-in and the flag, so the prompt is only asked when sharing could happen', async () => {
        delete syncData[CONSENT_KEY]

        // Signed out: answered before consent is even considered.
        localData = {}
        expect(await invoke(CAPTURE)).toEqual({ skipped: 'signed-out' })
        // Flag off: same.
        localData = { token: 'tok-123' }
        responses.push(features(false))
        expect(await invoke(CAPTURE)).toEqual({ skipped: 'disabled' })
    })

    it('a consent record that cannot be read is a real error (loud), never a send', async () => {
        responses.push(features(true))
        // Like Chrome: lastError is set only inside the failing call's own
        // callback, so the sign-in and flag reads before it still succeed.
        const realSyncGet = globalThis.chrome.storage.sync.get
        globalThis.chrome.storage.sync.get = (_keys, cb) => {
            globalThis.chrome.runtime.lastError = {
                message: 'sync unavailable',
            }
            try {
                cb({})
            } finally {
                globalThis.chrome.runtime.lastError = undefined
            }
        }

        const resp = await invoke(CAPTURE)

        globalThis.chrome.storage.sync.get = realSyncGet
        expect(resp.error).toMatch(/consent read failed: sync unavailable/)
        expect(submitCalls()).toHaveLength(0)
    })
})

describe('submitShopperCode — the submit and its answers', () => {
    it('flag on: POSTs {site, code, source:"checkout", consent} with the bearer', async () => {
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
            // The server's consent gate reads exactly this proof, taken from
            // the stored record the local gate just accepted.
            consent: {
                choice: 'accepted',
                promptVersion: 1,
                at: '2026-10-06T12:00:00.000Z',
            },
        })
        // The flag fetch is anonymous: nothing user-scoped in the answer.
        expect(featureCalls()[0].opts?.headers?.Authorization).toBeUndefined()
    })

    it('403 consent-required (the server refused our consent proof): a quiet skip that is NOT no-consent (that one re-opens the consent card), not an error', async () => {
        responses.push(
            features(true),
            refused(403, { error: 'consent-required' }),
        )

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'consent-rejected' })
        expect(localData.caramel_bg_errors).toBeUndefined()
    })

    it('the consent proof is never sent for a non-accepted record (nothing is submitted at all)', async () => {
        syncData[CONSENT_KEY] = consent('declined')
        responses.push(features(true))

        expect(await invoke(CAPTURE)).toEqual({ skipped: 'no-consent' })
        expect(submitCalls()).toHaveLength(0)
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

describe('couponBoxDiscoveryEnabled — the promo-box finder switch', () => {
    const ASK = { action: 'couponBoxDiscoveryEnabled' }

    it('an app that predates the flag (no key) answers off', async () => {
        responses.push(features(true))

        expect(await invoke(ASK)).toEqual({ enabled: false })
    })

    it('the flag on answers on', async () => {
        responses.push(
            ok({ shopperCodeCapture: false, couponBoxDiscovery: true }),
        )

        expect(await invoke(ASK)).toEqual({ enabled: true })
    })

    it('anything but a literal true is off ("true" the string included)', async () => {
        responses.push(
            ok({ shopperCodeCapture: false, couponBoxDiscovery: 'true' }),
        )

        expect(await invoke(ASK)).toEqual({ enabled: false })
    })

    it('a failed features read answers off instead of an error', async () => {
        responses.push(refused(500, null))

        expect(await invoke(ASK)).toEqual({ enabled: false })
    })

    it('shares the one cached features read with shopper capture', async () => {
        responses.push(
            ok({ shopperCodeCapture: true, couponBoxDiscovery: true }),
            ok({ couponId: 'c1', created: true, status: 'active' }),
        )

        expect(await invoke(ASK)).toEqual({ enabled: true })
        await invoke(CAPTURE)
        expect(featureCalls()).toHaveLength(1)
        expect(sessionData.caramel_features.couponBoxDiscovery).toBe(true)
    })

    it('while the finder is on, the cache lives 30 minutes even with capture on (the kill switch)', async () => {
        const t0 = 1_800_000_000_000
        const now = vi.spyOn(Date, 'now')
        now.mockReturnValue(t0)
        responses.push(
            ok({ shopperCodeCapture: true, couponBoxDiscovery: true }),
            ok({ shopperCodeCapture: true, couponBoxDiscovery: false }),
        )

        expect(await invoke(ASK)).toEqual({ enabled: true })
        now.mockReturnValue(t0 + 29 * 60 * 1000)
        expect(await invoke(ASK)).toEqual({ enabled: true })
        expect(featureCalls()).toHaveLength(1)

        // 31 minutes on: the owner switched it off, and the extension sees it.
        now.mockReturnValue(t0 + 31 * 60 * 1000)
        expect(await invoke(ASK)).toEqual({ enabled: false })
        expect(featureCalls()).toHaveLength(2)
        now.mockRestore()
    })
})

// T-10668: on a loaded machine the content script's finder-flag question went
// unanswered for its whole 15s wait, and the page took the finder for off.
// The worker's read had no bound of its own: an unbounded storage.session
// read, then a body read that fetchWithTimeout's clock (stopped at the
// headers) no longer covered. Every one of these must now be ANSWERED, within
// the 8s the read is given, and the reason recorded.
const never = () => new Promise(() => {})
const bgErrors = () => (localData.caramel_bg_errors || []).map(e => e.where)

describe('couponBoxDiscoveryEnabled — always answered, and in time (T-10668)', () => {
    const ASK = { action: 'couponBoxDiscoveryEnabled' }

    // The answer, or 'unanswered' if none came within `ms` of fake time.
    async function answerWithin(ms) {
        let answer = 'unanswered'
        handler(ASK, {}, resp => {
            answer = resp
        })
        await vi.advanceTimersByTimeAsync(ms)
        return answer
    }

    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('a features body that never arrives: answered off at the 8s deadline, and recorded', async () => {
        responses.push({ ok: true, status: 200, json: never })
        let answer = 'unanswered'
        handler(ASK, {}, resp => {
            answer = resp
        })

        await vi.advanceTimersByTimeAsync(7999)
        expect(answer).toBe('unanswered')
        await vi.advanceTimersByTimeAsync(1)
        expect(answer).toEqual({ enabled: false })
        expect(localData.caramel_bg_errors.at(-1)).toMatchObject({
            where: 'features',
            message: 'features read: no answer within 8000ms',
        })
    })

    it('a session cache read that never answers is skipped: the flag is still fetched and answered', async () => {
        chrome.storage.session.get = () => {}
        responses.push(
            ok({ shopperCodeCapture: false, couponBoxDiscovery: true }),
        )

        expect(await answerWithin(3000)).toEqual({ enabled: true })
        expect(bgErrors()).toEqual(['featuresSessionRead'])
    })

    it('after a read the deadline cut off, the next question asks the server again', async () => {
        responses.push(
            { ok: true, status: 200, json: never },
            ok({ shopperCodeCapture: false, couponBoxDiscovery: true }),
        )

        expect(await answerWithin(8000)).toEqual({ enabled: false })
        expect(await answerWithin(10)).toEqual({ enabled: true })
        expect(featureCalls()).toHaveLength(2)
    })

    it('a read that fails after its callers were answered is still recorded', async () => {
        let failLate
        responses.push(
            () =>
                new Promise((_, reject) => {
                    failLate = reject
                }),
        )

        expect(await answerWithin(8000)).toEqual({ enabled: false })
        failLate(new Error('network gone'))
        await vi.advanceTimersByTimeAsync(0)
        expect(bgErrors()).toEqual(['features', 'featuresLateFailure'])
        expect(localData.caramel_bg_errors.at(-1).message).toBe('network gone')
    })

    for (const [name, response] of [
        ['the request fails', new Error('offline')],
        ['the server answers 500', refused(500, null)],
        [
            'the body is not JSON',
            { ok: true, status: 200, json: async () => JSON.parse('<') },
        ],
        ['the body has no capture flag', ok({ couponBoxDiscovery: true })],
        ['the request never answers', never],
    ])
        it(`${name}: an answer within 8s, never silence`, async () => {
            responses.push(response)

            expect(await answerWithin(8000)).toEqual({ enabled: false })
            expect(bgErrors()).toContain('features')
        })

    it('a flag read from the server is remembered for the content script', async () => {
        vi.setSystemTime(1_800_000_000_000)
        responses.push(
            ok({ shopperCodeCapture: false, couponBoxDiscovery: true }),
        )

        expect(await answerWithin(0)).toEqual({ enabled: true })
        expect(localData.caramel_finder_flag).toEqual({
            on: true,
            ts: 1_800_000_000_000,
        })
    })

    // A hard "off" at the deadline is still a reply: the page's own fallback
    // never ran, and the finder stayed off (review of #621).
    describe('a read that fails answers the last flag the server gave', () => {
        const NOW = 1_800_000_000_000
        const MIN = 60 * 1000
        beforeEach(() => {
            vi.setSystemTime(NOW)
        })

        it('cut off at the deadline, remembered "on" from 10 minutes ago: on', async () => {
            localData.caramel_finder_flag = { on: true, ts: NOW - 10 * MIN }
            responses.push({ ok: true, status: 200, json: never })

            expect(await answerWithin(8000)).toEqual({ enabled: true })
            expect(bgErrors()).toEqual(['features'])
        })

        it('a 500 with a remembered "on": on', async () => {
            localData.caramel_finder_flag = { on: true, ts: NOW - MIN }
            responses.push(refused(500, null))

            expect(await answerWithin(0)).toEqual({ enabled: true })
        })

        it('remembered "on" 31 minutes old: off, so the kill switch still holds', async () => {
            localData.caramel_finder_flag = { on: true, ts: NOW - 31 * MIN }
            responses.push({ ok: true, status: 200, json: never })

            expect(await answerWithin(8000)).toEqual({ enabled: false })
        })

        it('remembered "off": off', async () => {
            localData.caramel_finder_flag = { on: false, ts: NOW - MIN }
            responses.push(refused(500, null))

            expect(await answerWithin(0)).toEqual({ enabled: false })
        })

        it('nothing remembered: off', async () => {
            responses.push(refused(500, null))

            expect(await answerWithin(0)).toEqual({ enabled: false })
            expect(bgErrors()).toEqual(['features'])
        })

        // Read alongside the features, so a slow storage.local does not
        // stack on top of the 8s deadline; bounded at 9s from the question.
        it('a memory read that never answers: off 9s after the question, and recorded', async () => {
            const realGet = chrome.storage.local.get
            chrome.storage.local.get = (keys, cb) =>
                [].concat(keys).includes('caramel_finder_flag')
                    ? undefined
                    : realGet(keys, cb)
            responses.push(refused(500, null))
            let answer = 'unanswered'
            handler({ action: 'couponBoxDiscoveryEnabled' }, {}, resp => {
                answer = resp
            })

            await vi.advanceTimersByTimeAsync(8999)
            expect(answer).toBe('unanswered')
            await vi.advanceTimersByTimeAsync(1)
            expect(answer).toEqual({ enabled: false })
            expect(bgErrors()).toEqual(['features', 'finderFlagMemoryRead'])
        })

        it('a memory slower than the features read still answers at the deadline, not after it', async () => {
            const realGet = chrome.storage.local.get
            let deliver
            chrome.storage.local.get = (keys, cb) =>
                [].concat(keys).includes('caramel_finder_flag')
                    ? (deliver = () =>
                          cb({
                              caramel_finder_flag: {
                                  on: true,
                                  ts: NOW - MIN,
                              },
                          }))
                    : realGet(keys, cb)
            responses.push({ ok: true, status: 200, json: never })
            let answer = 'unanswered'
            handler({ action: 'couponBoxDiscoveryEnabled' }, {}, resp => {
                answer = resp
            })

            // The memory arrives 5s in, while the features read still runs.
            await vi.advanceTimersByTimeAsync(5000)
            deliver()
            await vi.advanceTimersByTimeAsync(2999)
            expect(answer).toBe('unanswered')
            await vi.advanceTimersByTimeAsync(1)
            expect(answer).toEqual({ enabled: true })
        })

        it('an answer from a fresh cache reads no memory', async () => {
            responses.push(
                ok({ shopperCodeCapture: false, couponBoxDiscovery: true }),
            )
            expect(await answerWithin(0)).toEqual({ enabled: true })
            const realGet = chrome.storage.local.get
            const memoryReads = []
            chrome.storage.local.get = (keys, cb) => {
                if ([].concat(keys).includes('caramel_finder_flag'))
                    memoryReads.push(keys)
                return realGet(keys, cb)
            }

            expect(await answerWithin(0)).toEqual({ enabled: true })
            expect(memoryReads).toEqual([])
        })
    })
})
