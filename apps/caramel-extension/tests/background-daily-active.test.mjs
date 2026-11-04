import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FINDER_FLAG_MEMORY_KEY } from '../finder-flag-memory.js'

/**
 * background.js `reportDailyActive` — the popup-open daily-active event,
 * driven through the REAL worker message route with only the browser APIs and
 * the network stubbed. It rides the existing opt-in usage-diagnostics pipeline
 * (usage-diagnostics-consent.js + POST /api/extension/telemetry), so what this
 * pins is the gating order and the delivery state:
 *   - the toolbar popup only: popup.html in a tab or window (it has sender.tab)
 *     is skipped before anything is read, written or sent;
 *   - Google Chrome only, by detectStoreChannel (the install classifier);
 *   - nothing — no request (not even the features read), no state, no id —
 *     without accepted usage-diagnostics consent (prompt version 2);
 *   - nothing unless the cached features flag `extensionDauTelemetry` is
 *     exactly true (a failed read is off);
 *   - the existing diagnostics id is reused, never minted here;
 *   - no account link: no bearer, credentials 'omit', identical for guests and
 *     signed-in shoppers;
 *   - one successful send per UTC day, a new one after midnight, one in-flight
 *     attempt for concurrent opens, a bounded cooldown after a failure and no
 *     retry of its own.
 * The route side is apps/caramel-app/tests/unit/extension-telemetry-route.test.ts.
 */

const EXT = 'chrome-extension://caramel-test-id/'
const POPUP_SENDER = { url: `${EXT}popup.html` }
const T0 = Date.parse('2026-10-05T12:00:00Z')
const MIN = 60 * 1000
const CONSENT_KEY = 'usageDiagnosticsConsent'
const ID_KEY = 'caramel_usage_diagnostics_id'
const STATE_KEY = 'caramel_activity_state'
const TEST_ID = '0b9e8f2a-4c1d-4e57-9a36-7d5f1c2b8e40'
const EDGE_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

const consent = choice => ({
    choice,
    at: '2026-10-15T12:00:00.000Z',
    promptVersion: 2,
})

let handler
let fetchCalls
let telemetryResponses
let featuresResponse
let localData
let localSets
let runtimeUrl
let now

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
    stub.storage.local = {
        get: (keys, cb) =>
            cb(Object.fromEntries([].concat(keys).map(k => [k, localData[k]]))),
        set: (items, cb) => {
            localSets.push(items)
            Object.assign(localData, structuredClone(items))
            cb?.()
        },
        remove: (keys, cb) => {
            for (const k of [].concat(keys)) delete localData[k]
            cb?.()
        },
    }
    stub.storage.sync = { get: (_k, cb) => cb({}), set: (_i, cb) => cb?.() }
    // No session area: the features cache is memory-only per worker.
    stub.storage.session = undefined
    stub.runtime.lastError = undefined
    stub.runtime.getURL = path => runtimeUrl + path
    stub.runtime.getManifest = () => ({ version: '1.4.18' })
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

/** (Re)starts the worker: fresh module graph, same storage. */
async function startWorker() {
    vi.resetModules()
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
}

const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
})
const captured = () => reply(200, { captured: true })

function open(sender = POPUP_SENDER) {
    return new Promise(resolve =>
        handler({ action: 'recordExtensionActivity' }, sender, resolve),
    )
}

const telemetryCalls = () =>
    fetchCalls.filter(c => c.url.endsWith('/api/extension/telemetry'))
const featureCalls = () =>
    fetchCalls.filter(c => c.url.endsWith('/api/extension/features'))
const sentBody = i => JSON.parse(telemetryCalls()[i].opts.body)

function setUserAgent(ua) {
    Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => ua,
    })
}

beforeEach(async () => {
    fetchCalls = []
    telemetryResponses = []
    featuresResponse = () => reply(200, features(true))
    localData = {
        [CONSENT_KEY]: consent('accepted'),
        [ID_KEY]: TEST_ID,
    }
    localSets = []
    runtimeUrl = EXT
    now = vi.spyOn(Date, 'now').mockReturnValue(T0)
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        if (String(url).endsWith('/api/extension/features'))
            return featuresResponse()
        const next = telemetryResponses.shift()
        if (next instanceof Error) throw next
        if (typeof next === 'function') return next(opts)
        if (!next) throw new Error(`unexpected fetch ${url}`)
        return next
    }
    await startWorker()
})

afterEach(() => {
    delete navigator.userAgent
    vi.useRealTimers()
    vi.restoreAllMocks()
})

function features(extensionDauTelemetry) {
    return {
        shopperCodeCapture: false,
        couponBoxDiscovery: false,
        couponBoxLlm: false,
        couponBoxSave: false,
        ...(extensionDauTelemetry === undefined
            ? {}
            : { extensionDauTelemetry }),
    }
}

describe('reportDailyActive — the server flag (fail closed)', () => {
    it.each([
        ['false', () => reply(200, features(false))],
        [
            'absent (an app that predates the flag)',
            () => reply(200, features()),
        ],
        ['a truthy non-boolean', () => reply(200, features('true'))],
    ])(
        'flag %s: no telemetry POST, no state, the id untouched',
        async (_label, response) => {
            featuresResponse = response

            expect(await open()).toEqual({ skipped: 'disabled' })
            expect(telemetryCalls()).toEqual([])
            // Every successful features read remembers the finder flag
            // (finder-flag-memory.js); the daily-active path writes nothing.
            expect(
                localSets.filter(set => !(FINDER_FLAG_MEMORY_KEY in set)),
            ).toEqual([])
            expect(localData[ID_KEY]).toBe(TEST_ID)
        },
    )

    it.each([
        ['a 500', () => reply(500, {})],
        [
            'a network error',
            () => {
                throw new Error('Failed to fetch')
            },
        ],
    ])(
        'feature lookup fails (%s): treated as off, logged, nothing sent',
        async (_label, response) => {
            featuresResponse = response

            expect(await open()).toEqual({ skipped: 'disabled' })
            expect(telemetryCalls()).toEqual([])
            expect(STATE_KEY in localData).toBe(false)
            expect(localData.caramel_bg_errors?.[0]?.where).toBe('features')
        },
    )
})

describe('reportDailyActive — usage-diagnostics consent', () => {
    it.each([
        ['absent', undefined],
        ['declined', consent('declined')],
        ['malformed', { choice: 'accepted' }],
        [
            'another prompt version',
            { ...consent('accepted'), promptVersion: 9 },
        ],
        [
            'a v1 yes (the card before daily activity was named)',
            { ...consent('accepted'), promptVersion: 1 },
        ],
    ])(
        'consent %s: no request at all, no activity state',
        async (_label, stored) => {
            if (stored === undefined) delete localData[CONSENT_KEY]
            else localData[CONSENT_KEY] = stored

            expect(await open()).toEqual({ skipped: 'no-diagnostics-consent' })
            expect(fetchCalls).toEqual([])
            expect(STATE_KEY in localData).toBe(false)
        },
    )

    it('the real lifecycle: no id before the accept, sent under the minted id, nothing and no id after withdrawal', async () => {
        const { writeUsageDiagnosticsConsent } =
            await import('../usage-diagnostics-consent.js')
        localData = {}

        expect(await open()).toEqual({ skipped: 'no-diagnostics-consent' })
        expect(ID_KEY in localData).toBe(false)

        await writeUsageDiagnosticsConsent(chrome, 'accepted')
        const minted = localData[ID_KEY]
        expect(minted).toMatch(/^[0-9a-f-]{36}$/)
        telemetryResponses.push(captured())
        expect(await open()).toEqual({ sent: true })
        expect(sentBody(0).id).toBe(minted)
        expect(sentBody(0).consent).toEqual({
            choice: 'accepted',
            promptVersion: 2,
        })

        await writeUsageDiagnosticsConsent(chrome, 'declined')
        expect(ID_KEY in localData).toBe(false)
        now.mockReturnValue(T0 + 24 * 60 * MIN) // the next UTC day
        expect(await open()).toEqual({ skipped: 'no-diagnostics-consent' })
        expect(telemetryCalls()).toHaveLength(1)
    })

    it('withdrawn (record declined, id deleted by the withdrawal path): no POST, no new id', async () => {
        localData[CONSENT_KEY] = consent('declined')
        delete localData[ID_KEY]

        expect(await open()).toEqual({ skipped: 'no-diagnostics-consent' })
        expect(telemetryCalls()).toEqual([])
        expect(ID_KEY in localData).toBe(false)
        expect(STATE_KEY in localData).toBe(false)
    })

    it('accepted but no id (never minted here): skipped, none created, no state', async () => {
        delete localData[ID_KEY]

        expect(await open()).toEqual({ skipped: 'no-diagnostics-id' })
        expect(telemetryCalls()).toEqual([])
        expect(ID_KEY in localData).toBe(false)
        expect(STATE_KEY in localData).toBe(false)
    })
})

describe('reportDailyActive — what is sent', () => {
    it('consent accepted + flag true: one pseudonymous POST to the telemetry route with exactly the reviewed fields', async () => {
        telemetryResponses.push(captured())

        expect(await open()).toEqual({ sent: true })

        expect(telemetryCalls()).toHaveLength(1)
        const { url, opts } = telemetryCalls()[0]
        expect(url).toBe('https://grabcaramel.com/api/extension/telemetry')
        expect(opts.method).toBe('POST')
        expect(opts.credentials).toBe('omit')
        expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
        expect(sentBody(0)).toEqual({
            id: TEST_ID,
            event: {
                kind: 'daily_active',
                day: '2026-10-05',
                extVersion: '1.4.18',
                browser: 'chrome',
            },
            consent: { choice: 'accepted', promptVersion: 2 },
        })
        // The existing id is reused: reporting never writes one.
        expect(localSets.some(s => ID_KEY in s)).toBe(false)
        expect(localData[ID_KEY]).toBe(TEST_ID)
        expect(localData[STATE_KEY]).toEqual({ sentDay: '2026-10-05' })
    })

    it('signed in and guest send byte-identical requests (no bearer, no sign-in state)', async () => {
        telemetryResponses.push(captured())
        await open()
        const guest = telemetryCalls()[0].opts

        localData = {
            [CONSENT_KEY]: consent('accepted'),
            [ID_KEY]: TEST_ID,
            token: 'tok-123',
            user: { username: 'sam' },
        }
        await startWorker()
        telemetryResponses.push(captured())
        await open()
        const signedIn = telemetryCalls()[1].opts

        expect(signedIn.body).toBe(guest.body)
        expect(signedIn.headers).toEqual(guest.headers)
        expect(signedIn.credentials).toBe('omit')
        expect(signedIn.headers.Authorization).toBeUndefined()
        expect(signedIn.body).not.toMatch(/tok-123|sam|signed/)
    })

    it('only the popup page can trigger it', async () => {
        expect(
            await open({ url: 'https://shop.example/cart', tab: { id: 4 } }),
        ).toEqual({ error: 'not_popup' })
        expect(await open({})).toEqual({ error: 'not_popup' })
        expect(fetchCalls).toEqual([])
    })

    describe.each([
        [
            'the apply flow sign-in window',
            {
                url: `${EXT}popup.html?isPopup=true&callerId=4`,
                tab: { id: 9, windowId: 8 },
                frameId: 0,
            },
        ],
        [
            'bare popup.html in a tab (typed URL or a website link)',
            {
                url: `${EXT}popup.html`,
                tab: { id: 9, windowId: 8 },
                frameId: 0,
            },
        ],
    ])('%s is not a toolbar popup open', (_label, sender) => {
        // beforeEach has consent accepted and the flag on, so only the sender
        // can be what stops these.
        it('skips: no fetch at all, no storage write, the id untouched, nothing logged', async () => {
            expect(await open(sender)).toEqual({
                skipped: 'not-toolbar-popup',
            })

            expect(fetchCalls).toEqual([])
            expect(localSets).toEqual([])
            expect(STATE_KEY in localData).toBe(false)
            expect(localData[ID_KEY]).toBe(TEST_ID)
            expect(localData.caramel_bg_errors).toBeUndefined()
        })

        it('does not consume the day: the toolbar popup still sends once', async () => {
            telemetryResponses.push(captured())

            await open(sender)
            expect(await open()).toEqual({ sent: true })
            expect(await open()).toEqual({ skipped: 'not-due' })

            expect(telemetryCalls()).toHaveLength(1)
            expect(sentBody(0).id).toBe(TEST_ID)
        })
    })

    it('delivery does not depend on the popup staying open', async () => {
        telemetryResponses.push(captured())
        // The popup closed: Chrome turns sendResponse into a no-op.
        handler({ action: 'recordExtensionActivity' }, POPUP_SENDER, () => {})

        await vi.waitFor(() =>
            expect(localData[STATE_KEY]).toEqual({ sentDay: '2026-10-05' }),
        )
    })
})

describe('reportDailyActive — Google Chrome only, by detectStoreChannel', () => {
    it.each([
        ['Microsoft Edge (same Chromium zip, Edg/ UA)', EXT, EDGE_UA],
        ['Firefox', 'moz-extension://caramel-test-id/', undefined],
        ['Safari', 'safari-web-extension://caramel-test-id/', undefined],
    ])('%s: nothing is read or sent', async (_label, base, ua) => {
        runtimeUrl = base
        if (ua) setUserAgent(ua)
        await startWorker()

        expect(await open({ url: `${base}popup.html` })).toEqual({
            skipped: 'not-chrome',
        })
        expect(fetchCalls).toEqual([])
        expect(localSets).toEqual([])
    })

    it('the same classifier the funnel stamps `browser` with', async () => {
        const { detectStoreChannel } = await import('../background.js')
        expect(detectStoreChannel(EXT, navigator.userAgent)).toBe('chrome')
        expect(detectStoreChannel(EXT, EDGE_UA)).toBe('edge')
    })
})

describe('reportDailyActive — once per UTC day', () => {
    it('repeat opens the same UTC day send nothing more', async () => {
        telemetryResponses.push(captured())
        await open()
        now.mockReturnValue(T0 + 11 * 60 * MIN) // 23:00Z, same day

        expect(await open()).toEqual({ skipped: 'not-due' })
        expect(await open()).toEqual({ skipped: 'not-due' })
        expect(telemetryCalls()).toHaveLength(1)
    })

    it('UTC rollover: the next day sends again, under the SAME diagnostics id', async () => {
        now.mockReturnValue(Date.parse('2026-10-05T23:59:30Z'))
        telemetryResponses.push(captured(), captured())
        await open()
        now.mockReturnValue(Date.parse('2026-10-06T00:00:30Z'))

        expect(await open()).toEqual({ sent: true })
        expect([sentBody(0).event.day, sentBody(1).event.day]).toEqual([
            '2026-10-05',
            '2026-10-06',
        ])
        expect(sentBody(1).id).toBe(sentBody(0).id)
    })

    it('a restarted worker keeps the sent day', async () => {
        telemetryResponses.push(captured())
        await open()

        await startWorker()
        expect(await open()).toEqual({ skipped: 'not-due' })
        expect(telemetryCalls()).toHaveLength(1)
    })

    it('concurrent popup opens share one in-flight attempt: one request', async () => {
        let release
        telemetryResponses.push(
            () => new Promise(r => (release = () => r(captured()))),
        )

        const pending = [open(), open(), open()]
        await vi.waitFor(() => expect(telemetryCalls()).toHaveLength(1))
        release()

        expect(await Promise.all(pending)).toEqual([
            { sent: true },
            { sent: true },
            { sent: true },
        ])
        expect(telemetryCalls()).toHaveLength(1)
        expect(featureCalls()).toHaveLength(1)
    })
})

describe('reportDailyActive — failures cool down, never mark the day sent', () => {
    it.each([
        ['a network error', new Error('Failed to fetch')],
        ['a 500', reply(500, { error: 'Internal server error' })],
        ['a 429', reply(429, { error: 'Too many requests' })],
        ['a 422', reply(422, { error: 'Invalid request body' })],
        [
            'not captured (server flag off, or PostHog down)',
            reply(200, { captured: false }),
        ],
    ])(
        '%s: answered as an error, logged, 30-minute cooldown, retried by the next open after it',
        async (_label, response) => {
            telemetryResponses.push(response)

            const answer = await open()
            expect(answer.error).toBeTruthy()
            expect(localData[STATE_KEY]).toEqual({
                retryDay: '2026-10-05',
                retryAfter: T0 + 30 * MIN,
            })
            expect(localData.caramel_bg_errors?.[0]?.where).toBe(
                'recordExtensionActivity',
            )
            expect(JSON.stringify(localData.caramel_bg_errors)).not.toContain(
                TEST_ID,
            )

            now.mockReturnValue(T0 + 29 * MIN)
            expect(await open()).toEqual({ skipped: 'not-due' })
            expect(telemetryCalls()).toHaveLength(1)

            now.mockReturnValue(T0 + 31 * MIN)
            telemetryResponses.push(captured())
            expect(await open()).toEqual({ sent: true })
            expect(localData[STATE_KEY]).toEqual({ sentDay: '2026-10-05' })
        },
    )

    it('the server refusing the consent proof (403 consent-required) cools down too', async () => {
        telemetryResponses.push(reply(403, { error: 'consent-required' }))

        expect(await open()).toEqual({ skipped: 'consent-rejected' })
        expect(localData[STATE_KEY]).toEqual({
            retryDay: '2026-10-05',
            retryAfter: T0 + 30 * MIN,
        })
    })

    it('a cooldown never outlives its UTC day', async () => {
        now.mockReturnValue(Date.parse('2026-10-05T23:50:00Z'))
        telemetryResponses.push(reply(500, {}))
        await open()
        now.mockReturnValue(Date.parse('2026-10-06T00:05:00Z'))
        telemetryResponses.push(captured())

        expect(await open()).toEqual({ sent: true })
    })

    it('a cooldown further out than its own length (clock moved back) is not honoured', async () => {
        localData[STATE_KEY] = {
            retryDay: '2026-10-05',
            retryAfter: T0 + 10 * 60 * MIN,
        }
        telemetryResponses.push(captured())

        expect(await open()).toEqual({ sent: true })
    })

    it('a hung request is aborted by the 8 s fetch budget; there is no retry of its own', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        telemetryResponses.push(
            opts =>
                new Promise((_resolve, reject) =>
                    opts.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    ),
                ),
        )

        const pending = open()
        await vi.waitFor(() => expect(telemetryCalls()).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(8000)

        expect((await pending).error).toMatch(/aborted/)
        await vi.advanceTimersByTimeAsync(60 * MIN)
        expect(telemetryCalls()).toHaveLength(1)
    })
})
