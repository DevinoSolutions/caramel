import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CODE_SHARE_FUNNEL_STEP_REASONS } from '../code-share-funnel.js'

/**
 * background.js `reportCodeShareFunnel` — the gate between a funnel step the
 * page reported and the network. The page is deliberately dumb; THIS decides
 * whether anything may leave the browser (the shopper's usageDiagnosticsConsent
 * accepted and, on Firefox, the browser's data-collection grant held) and
 * builds the payload from the allowlist, whatever the message carried.
 */

let handler
let storageListeners
let fetchCalls
let responses
let localData
let syncData
let runtimeUrl
let permissions

const CONSENT_KEY = 'usageDiagnosticsConsent'
const ID_KEY = 'caramel_usage_diagnostics_id'
const TEST_ID = '0b9e8f2a-4c1d-4e57-9a36-7d5f1c2b8e40'
const consent = choice => ({
    choice,
    at: '2026-10-15T12:00:00.000Z',
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
    stub.storage.session = area(() => ({}))
    stub.storage.onChanged.addListener = fn => storageListeners.push(fn)
    stub.runtime.lastError = undefined
    stub.runtime.getURL = () => runtimeUrl
    stub.runtime.getManifest = () => ({ version: '1.4.14' })
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = permissions ? { permissions } : undefined
    return listeners
}

const ok = body => ({ ok: true, status: 200, json: async () => body })
const refused = (status, body) => ({
    ok: false,
    status,
    json: async () => body,
})

function invoke(message) {
    return new Promise(resolve => handler(message, {}, resolve))
}

const STEP = {
    action: 'reportCodeShareFunnel',
    step: 'capture_armed',
    store: 'example.com',
}

const telemetryCalls = () =>
    fetchCalls.filter(c => c.url.includes('api/extension/telemetry'))

async function boot() {
    vi.resetModules()
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
}

beforeEach(async () => {
    fetchCalls = []
    responses = []
    storageListeners = []
    // Consent is DEVICE-LOCAL (never roams), and the id was minted by the accept
    // path before any report runs.
    localData = {
        token: 'tok-123',
        [CONSENT_KEY]: consent('accepted'),
        [ID_KEY]: TEST_ID,
    }
    syncData = {}
    runtimeUrl = 'chrome-extension://abc/'
    permissions = undefined
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        const next = responses.shift()
        if (next instanceof Error) throw next
        if (!next) throw new Error(`unexpected fetch ${url}`)
        return next
    }
    await boot()
})

describe('reportCodeShareFunnel: no send without accepted consent', () => {
    it.each([
        ['no record', undefined],
        ['declined', consent('declined')],
        ['malformed', { choice: 'accepted' }],
        [
            'another prompt version',
            { ...consent('accepted'), promptVersion: 9 },
        ],
    ])('%s: skipped, and NOTHING is fetched', async (_label, stored) => {
        if (stored === undefined) delete localData[CONSENT_KEY]
        else localData[CONSENT_KEY] = stored

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(fetchCalls).toEqual([])
    })

    it('a stale code-sharing consent is NOT diagnostics consent', async () => {
        delete localData[CONSENT_KEY]
        syncData.checkoutCodeSharingConsent = consent('accepted')

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(fetchCalls).toEqual([])
    })

    it('Firefox: accepted consent but the browser grant not held => nothing is sent', async () => {
        runtimeUrl = 'moz-extension://abc/'
        permissions = {
            contains: vi.fn(async () => false),
            request: vi.fn(),
        }
        await boot()

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(fetchCalls).toEqual([])
        expect(permissions.contains).toHaveBeenCalledWith({
            data_collection: ['technicalAndInteraction'],
        })
    })

    it('Firefox: consent accepted and the grant held => sent', async () => {
        runtimeUrl = 'moz-extension://abc/'
        permissions = { contains: vi.fn(async () => true), request: vi.fn() }
        await boot()
        responses.push(ok({ captured: true }))

        expect(await invoke(STEP)).toEqual({ sent: true })
        expect(JSON.parse(telemetryCalls()[0].opts.body).event.browser).toBe(
            'firefox',
        )
    })

    it('an unreadable consent record rejects loudly (answered as { error }), sending nothing', async () => {
        const realGet = globalThis.chrome.storage.local.get
        globalThis.chrome.storage.local.get = (_keys, cb) => {
            globalThis.chrome.runtime.lastError = { message: 'storage down' }
            cb()
            globalThis.chrome.runtime.lastError = undefined
        }

        const answer = await invoke(STEP)
        globalThis.chrome.storage.local.get = realGet

        expect(answer.error).toMatch(/storage down/)
        expect(fetchCalls).toEqual([])
    })
})

describe('reportCodeShareFunnel: what is sent when the shopper opted in', () => {
    it('posts the allowlisted event, the telemetry id and the consent proof - anonymously', async () => {
        responses.push(ok({ captured: true }))

        expect(await invoke(STEP)).toEqual({ sent: true })

        const [call] = telemetryCalls()
        expect(call.url).toMatch(/\/api\/extension\/telemetry$/)
        expect(call.opts.method).toBe('POST')
        // Anonymous: no bearer, no cookies, despite a stored sign-in token.
        expect(call.opts.headers.Authorization).toBeUndefined()
        expect(call.opts.credentials).toBe('omit')
        const body = JSON.parse(call.opts.body)
        expect(Object.keys(body).toSorted()).toEqual(['consent', 'event', 'id'])
        expect(body.id).toBe(TEST_ID)
        expect(body.consent).toEqual({ choice: 'accepted', promptVersion: 1 })
        expect(body.event).toEqual({
            step: 'capture_armed',
            store: 'example.com',
            extVersion: '1.4.14',
            browser: 'chrome',
            sharingPromptVersion: 1,
        })
        expect(call.opts.body).not.toContain('tok-123')
    })

    it('a consent record that roamed in through storage.sync is ignored: nothing is sent', async () => {
        delete localData[CONSENT_KEY]
        syncData[CONSENT_KEY] = consent('accepted')

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(fetchCalls).toEqual([])
    })

    it('the report path never mints an id: no id means skip, and none is created', async () => {
        delete localData[ID_KEY]

        expect(await invoke(STEP)).toEqual({ skipped: 'no-diagnostics-id' })
        expect(fetchCalls).toEqual([])
        expect(ID_KEY in localData).toBe(false)
    })

    it('consent withdrawn while the id was being read: re-checked, nothing is sent', async () => {
        const realGet = globalThis.chrome.storage.local.get
        globalThis.chrome.storage.local.get = (keys, cb) =>
            realGet(keys, res => {
                if ([].concat(keys).includes(ID_KEY))
                    localData[CONSENT_KEY] = consent('declined')
                cb(res)
            })

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(fetchCalls).toEqual([])
    })

    it('the same id is reused on every report', async () => {
        responses.push(ok({ captured: true }), ok({ captured: true }))

        await invoke(STEP)
        await invoke(STEP)

        expect(telemetryCalls().map(c => JSON.parse(c.opts.body).id)).toEqual([
            TEST_ID,
            TEST_ID,
        ])
    })

    it('a code, user, URL or cart on the message never reaches the request', async () => {
        responses.push(ok({ captured: true }))

        await invoke({
            ...STEP,
            step: 'apply_observed',
            code: 'SAVE10',
            site: 'example.com',
            url: 'https://example.com/cart?coupon=SAVE10',
            email: 'a@b.co',
            userId: 'u-9',
            cart: ['shoes'],
        })

        const raw = telemetryCalls()[0].opts.body
        expect(raw).not.toMatch(/SAVE10|a@b\.co|u-9|shoes|cart|coupon=/)
        expect(Object.keys(JSON.parse(raw).event).toSorted()).toEqual([
            'browser',
            'extVersion',
            'sharingPromptVersion',
            'step',
            'store',
        ])
    })

    it('sends the reason for the steps that carry one', async () => {
        responses.push(ok({ captured: true }))

        await invoke({ ...STEP, step: 'submit_skipped', reason: 'flag-off' })

        expect(JSON.parse(telemetryCalls()[0].opts.body).event).toMatchObject({
            step: 'submit_skipped',
            reason: 'flag-off',
        })
    })

    it('every step and reason in the vocabulary is accepted by the real handler', async () => {
        for (const [step, reasons] of Object.entries(
            CODE_SHARE_FUNNEL_STEP_REASONS,
        )) {
            for (const reason of reasons.length ? reasons : [undefined]) {
                responses.push(ok({ captured: true }))
                expect(await invoke({ ...STEP, step, reason })).toEqual({
                    sent: true,
                })
            }
        }
    })

    it.each([
        ['an unknown step', { step: 'sent_the_code' }],
        ['a reason on a step that takes none', { reason: 'signed-out' }],
        ['a store that is a URL', { store: 'https://example.com/cart' }],
        ['no store at all', { store: undefined }],
    ])(
        '%s is refused loudly (answered as { error }), nothing sent',
        async (_label, patch) => {
            const answer = await invoke({ ...STEP, ...patch })

            expect(answer.error).toBeTruthy()
            expect(fetchCalls).toEqual([])
        },
    )
})

describe('reportCodeShareFunnel: failures are surfaced, never swallowed', () => {
    it('a 5xx throws (answered as { error }) - no retry queue', async () => {
        responses.push(refused(503, { error: 'down' }))

        const answer = await invoke(STEP)

        expect(answer.error).toMatch(/telemetry HTTP 503 down/)
        expect(fetchCalls).toHaveLength(1)
    })

    it('a response where the server did not capture the event is an error, not a success', async () => {
        responses.push(ok({ captured: false }))

        expect((await invoke(STEP)).error).toMatch(/did not capture/)
    })

    it('a network failure is an error', async () => {
        responses.push(new TypeError('Failed to fetch'))

        expect((await invoke(STEP)).error).toMatch(/Failed to fetch/)
    })

    it('the server consent floor refusing the proof is a quiet skip, and says so', async () => {
        responses.push(refused(403, { error: 'consent-required' }))

        expect(await invoke(STEP)).toEqual({ skipped: 'consent-rejected' })
    })

    it('a different 403 (origin gate) is a real failure', async () => {
        responses.push(refused(403, { error: 'Forbidden' }))

        expect((await invoke(STEP)).error).toMatch(/HTTP 403/)
    })
})

describe('withdrawing consent stops sends at once and deletes the telemetry id', () => {
    it('after the record flips to declined no request is made', async () => {
        responses.push(ok({ captured: true }))
        expect(await invoke(STEP)).toEqual({ sent: true })

        localData[CONSENT_KEY] = consent('declined')

        expect(await invoke(STEP)).toEqual({
            skipped: 'no-diagnostics-consent',
        })
        expect(telemetryCalls()).toHaveLength(1)
    })

    it('the storage listener deletes the id when the record turns declined, is removed, or is malformed', async () => {
        for (const newValue of [consent('declined'), undefined, { bad: 1 }]) {
            localData[ID_KEY] = 'some-id'
            for (const fn of storageListeners)
                fn({ [CONSENT_KEY]: { newValue } }, 'local')
            await vi.waitFor(() => expect(ID_KEY in localData).toBe(false))
        }
    })

    it('an accepted record (or an unrelated change) leaves the id alone', async () => {
        localData[ID_KEY] = 'some-id'
        for (const fn of storageListeners) {
            fn({ [CONSENT_KEY]: { newValue: consent('accepted') } }, 'local')
            // A roamed (sync) change to the same key is not this device's record.
            fn({ [CONSENT_KEY]: { newValue: consent('declined') } }, 'sync')
            fn({ other: { newValue: 1 } }, 'local')
        }
        await Promise.resolve()

        expect(localData[ID_KEY]).toBe('some-id')
    })
})
