import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaramelExtensionActivity } from '../coupon-constants.generated.js'
import { isGoogleChromeRuntime } from '../extension-activity.js'

/**
 * The daily-active-installation ping, driven through the REAL worker message
 * route (background.js → extension-activity.js → fetchCaramelApi) with only
 * the browser APIs and the network stubbed. What this pins:
 *   - only the popup page can trigger it, and only one success per UTC day;
 *   - the dailyId is SHA-256(domain \0 seed \0 day), rotates at UTC midnight,
 *     and does not depend on sign-in state;
 *   - only the route's explicit `recorded` marks the day done; disabled /
 *     failure / timeout cool down (bounded) and the next popup open retries;
 *   - concurrency, worker restarts, and what leaves the browser.
 * The route side (signed_in derivation, PostHog properties) is pinned in
 * apps/caramel-app/tests/unit/extension-activity-route.test.ts.
 */

const EXT = 'chrome-extension://caramel-test-id/'
const POPUP_SENDER = { url: `${EXT}popup.html` }
const T0 = Date.parse('2026-10-05T12:00:00Z')
const MIN = 60 * 1000

let handler
let fetchCalls
let responses
let localData
let localSets

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
    stub.storage.sync = {
        get: (_keys, cb) => cb({}),
        set: (_items, cb) => cb?.(),
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = path => EXT + path
    stub.runtime.getManifest = () => ({ version: '1.4.3' })
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
const recorded = () => reply(200, { status: 'recorded' })

function open(sender = POPUP_SENDER) {
    return new Promise(resolve =>
        handler({ action: 'recordExtensionActivity' }, sender, resolve),
    )
}

const activityCalls = () =>
    fetchCalls.filter(c => c.url.endsWith(CaramelExtensionActivity.PATH))
const sentBody = i => JSON.parse(activityCalls()[i].opts.body)
const expectedDailyId = (seed, day) =>
    createHash('sha256')
        .update(`${CaramelExtensionActivity.ID_DOMAIN}\0${seed}\0${day}`)
        .digest('hex')

let now
beforeEach(async () => {
    fetchCalls = []
    responses = []
    localData = {}
    localSets = []
    now = vi.spyOn(Date, 'now').mockReturnValue(T0)
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        const next = responses.shift()
        if (next instanceof Error) throw next
        if (typeof next === 'function') return next(opts)
        if (!next) throw new Error(`unexpected fetch ${url}`)
        return next
    }
    await startWorker()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('recordExtensionActivity — request shape and privacy', () => {
    it('guest popup open: one POST to the first-party route, no bearer, exactly the four contract fields', async () => {
        responses.push(recorded())

        expect(await open()).toEqual({ outcome: 'recorded' })

        expect(activityCalls()).toHaveLength(1)
        const call = activityCalls()[0]
        expect(call.url).toBe(
            `https://grabcaramel.com/${CaramelExtensionActivity.PATH}`,
        )
        expect(call.opts.method).toBe('POST')
        expect(call.opts.headers.Authorization).toBeUndefined()
        const body = sentBody(0)
        expect(Object.keys(body).toSorted()).toEqual([
            'browser',
            'dailyId',
            'day',
            'extensionVersion',
        ])
        expect(body).toMatchObject({
            day: '2026-10-05',
            extensionVersion: '1.4.3',
            browser: 'chrome',
        })
        expect(body.dailyId).toBe(
            expectedDailyId(localData.caramel_activity_seed, '2026-10-05'),
        )
    })

    it('signed-in popup open: the stored bearer rides along (the server derives signed_in), the body is unchanged', async () => {
        localData.token = 'tok-123'
        responses.push(recorded())

        expect(await open()).toEqual({ outcome: 'recorded' })

        expect(activityCalls()[0].opts.headers.Authorization).toBe(
            'Bearer tok-123',
        )
        expect(Object.keys(sentBody(0)).toSorted()).toEqual([
            'browser',
            'dailyId',
            'day',
            'extensionVersion',
        ])
    })

    it('the seed is 32 random bytes kept in storage.local and is never transmitted', async () => {
        localData.token = 'tok-123'
        responses.push(recorded())
        await open()

        const seed = localData.caramel_activity_seed
        expect(seed).toMatch(/^[0-9a-f]{64}$/)
        const wire = JSON.stringify(activityCalls()[0])
        expect(wire).not.toContain(seed)
        // Nothing identifying or browsing-related rides in the request.
        expect(wire).not.toMatch(/user|email|domain|site|coupon|href/i)
    })

    it('only the popup page can trigger it — a content-script tab or unknown sender is refused with no request', async () => {
        expect(
            await open({ url: 'https://shop.example/cart', tab: { id: 4 } }),
        ).toEqual({ error: 'not_popup' })
        expect(await open({})).toEqual({ error: 'not_popup' })
        expect(fetchCalls).toEqual([])
        expect(localData.caramel_activity_seed).toBeUndefined()
    })

    it('the sign-in window opened from checkout is the popup page too, and counts', async () => {
        responses.push(recorded())
        expect(
            await open({
                url: `${EXT}popup.html?isPopup=true&callerId=7`,
                tab: { id: 9 },
            }),
        ).toEqual({ outcome: 'recorded' })
    })
})

describe('recordExtensionActivity — once per UTC day', () => {
    it('repeat opens the same UTC day send nothing more', async () => {
        responses.push(recorded())
        await open()
        now.mockReturnValue(T0 + 11 * 60 * MIN) // 23:00Z, same day

        expect(await open()).toEqual({ outcome: 'already-recorded' })
        expect(await open()).toEqual({ outcome: 'already-recorded' })
        expect(activityCalls()).toHaveLength(1)
    })

    it('rotates at UTC midnight: a new day sends a new, unlinkable dailyId from the same seed', async () => {
        now.mockReturnValue(Date.parse('2026-10-05T23:59:30Z'))
        responses.push(recorded(), recorded())
        await open()
        now.mockReturnValue(Date.parse('2026-10-06T00:00:30Z'))

        expect(await open()).toEqual({ outcome: 'recorded' })

        const [a, b] = [sentBody(0), sentBody(1)]
        expect([a.day, b.day]).toEqual(['2026-10-05', '2026-10-06'])
        expect(a.dailyId).not.toBe(b.dailyId)
        const seed = localData.caramel_activity_seed
        expect(a.dailyId).toBe(expectedDailyId(seed, '2026-10-05'))
        expect(b.dailyId).toBe(expectedDailyId(seed, '2026-10-06'))
    })

    it('signing in or out the same day keeps the same dailyId (auth never re-counts an installation)', async () => {
        localData.token = 'tok-123'
        responses.push(reply(502, { status: 'capture_failed' }))
        await open()
        // Sign out, wait out the failure cooldown, open again.
        delete localData.token
        now.mockReturnValue(T0 + 31 * MIN)
        responses.push(recorded())
        await open()

        expect(activityCalls()).toHaveLength(2)
        expect(activityCalls()[0].opts.headers.Authorization).toBe(
            'Bearer tok-123',
        )
        expect(activityCalls()[1].opts.headers.Authorization).toBeUndefined()
        expect(sentBody(1).dailyId).toBe(sentBody(0).dailyId)
    })
})

describe('recordExtensionActivity — concurrency and worker lifecycle', () => {
    it('concurrent popup opens share one attempt: one seed, one request', async () => {
        let release
        responses.push(() => new Promise(r => (release = () => r(recorded()))))

        const pending = [open(), open(), open()]
        await vi.waitFor(() => expect(activityCalls()).toHaveLength(1))
        release()

        expect(await Promise.all(pending)).toEqual([
            { outcome: 'recorded' },
            { outcome: 'recorded' },
            { outcome: 'recorded' },
        ])
        expect(
            localSets.filter(s => 'caramel_activity_seed' in s),
        ).toHaveLength(1)
    })

    it('a restarted worker keeps the seed and the recorded day', async () => {
        responses.push(recorded())
        await open()
        const seed = localData.caramel_activity_seed

        await startWorker()
        expect(await open()).toEqual({ outcome: 'already-recorded' })

        // …and the next day's id still comes from the SAME seed.
        now.mockReturnValue(T0 + 24 * 60 * MIN)
        responses.push(recorded())
        await open()
        expect(localData.caramel_activity_seed).toBe(seed)
        expect(sentBody(1).dailyId).toBe(expectedDailyId(seed, '2026-10-06'))
    })

    it('delivery does not depend on the popup: the day is recorded even when nobody is left to hear the answer', async () => {
        responses.push(recorded())
        // The popup closed: Chrome turns sendResponse into a no-op.
        handler({ action: 'recordExtensionActivity' }, POPUP_SENDER, () => {})

        await vi.waitFor(() =>
            expect(localData.caramel_activity_state).toEqual({
                recordedDay: '2026-10-05',
            }),
        )
        expect(activityCalls()).toHaveLength(1)
    })
})

describe('recordExtensionActivity — only an explicit `recorded` counts', () => {
    it('kill switch off ({status:"disabled"}): not recorded, 6h cooldown, then asks again', async () => {
        responses.push(reply(200, { status: 'disabled' }))
        expect(await open()).toEqual({ outcome: 'disabled' })
        expect(localData.caramel_activity_state.recordedDay).toBeUndefined()

        now.mockReturnValue(T0 + 5 * 60 * MIN)
        expect(await open()).toEqual({ outcome: 'cooldown' })
        expect(activityCalls()).toHaveLength(1)

        // Flag flipped on by a maintainer; the next open past the cooldown records.
        now.mockReturnValue(T0 + 6 * 60 * MIN + 1)
        responses.push(recorded())
        expect(await open()).toEqual({ outcome: 'recorded' })
        expect(activityCalls()).toHaveLength(2)
    })

    it('a cooldown never outlives its UTC day', async () => {
        now.mockReturnValue(Date.parse('2026-10-05T23:00:00Z'))
        responses.push(reply(200, { status: 'disabled' }))
        await open()
        now.mockReturnValue(Date.parse('2026-10-06T00:05:00Z'))
        responses.push(recorded())

        expect(await open()).toEqual({ outcome: 'recorded' })
    })

    it('capture failed (502): not recorded, logged without the id, 30-minute cooldown, then retried by the next open', async () => {
        responses.push(reply(502, { status: 'capture_failed' }))
        expect(await open()).toEqual({ outcome: 'failed' })

        const errors = localData.caramel_bg_errors
        expect(errors).toHaveLength(1)
        expect(errors[0].message).toBe('activity HTTP 502 capture_failed')
        expect(JSON.stringify(errors)).not.toContain(sentBody(0).dailyId)

        now.mockReturnValue(T0 + 29 * MIN)
        expect(await open()).toEqual({ outcome: 'cooldown' })
        now.mockReturnValue(T0 + 31 * MIN)
        responses.push(recorded())
        expect(await open()).toEqual({ outcome: 'recorded' })
        expect(activityCalls()).toHaveLength(2)
    })

    it.each([
        ['a 2xx without status', reply(200, {})],
        ['a 2xx with an unknown status', reply(204, { status: 'ok' })],
        [
            'an unreadable 2xx body',
            {
                ok: true,
                status: 200,
                json: () => Promise.reject(new Error('bad json')),
            },
        ],
        ['a 422 refusal', reply(422, { error: 'Invalid request body' })],
        ['a 429', reply(429, { error: 'Too many requests' })],
        ['a 500', reply(500, { error: 'Internal server error' })],
    ])('%s is a failure, never a recorded day', async (_label, response) => {
        responses.push(response)

        expect(await open()).toEqual({ outcome: 'failed' })
        expect(localData.caramel_activity_state.recordedDay).toBeUndefined()
        expect(localData.caramel_activity_state.retryAfter).toBe(T0 + 30 * MIN)
    })

    it('a network error is a failure with the same bounded cooldown', async () => {
        responses.push(new Error('Failed to fetch'))

        expect(await open()).toEqual({ outcome: 'failed' })
        expect(localData.caramel_activity_state.retryAfter).toBe(T0 + 30 * MIN)
    })

    it('a hung request is aborted by the 8s fetch budget and treated as a failure — no automatic retry', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        responses.push(
            opts =>
                new Promise((_resolve, reject) =>
                    opts.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    ),
                ),
        )

        const pending = open()
        await vi.waitFor(() => expect(activityCalls()).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(8000)

        expect(await pending).toEqual({ outcome: 'failed' })
        await vi.advanceTimersByTimeAsync(60 * MIN)
        expect(activityCalls()).toHaveLength(1)
    })
})

const brands = (...names) => names.map(brand => ({ brand, version: '130' }))

describe('isGoogleChromeRuntime — browser scope', () => {
    const chrome = brands('Chromium', 'Google Chrome', 'Not?A_Brand')

    it('Google Chrome (Chrome build, chrome-extension origin, Chrome brand) → true', () => {
        expect(
            isGoogleChromeRuntime({
                buildBrowser: 'chrome',
                isSafari: false,
                brands: chrome,
            }),
        ).toBe(true)
        // GREASE brand spellings rotate across Chrome versions.
        expect(
            isGoogleChromeRuntime({
                buildBrowser: 'chrome',
                isSafari: false,
                brands: brands('Not A(Brand', 'Google Chrome', 'Chromium'),
            }),
        ).toBe(true)
    })

    it.each([
        ['Microsoft Edge', brands('Chromium', 'Microsoft Edge', 'Not?A_Brand')],
        [
            'Edge (if it ever adds the Chrome brand too)',
            brands('Google Chrome', 'Microsoft Edge', 'Chromium'),
        ],
        ['Opera', brands('Chromium', 'Opera', 'Not?A_Brand')],
        ['Brave', brands('Chromium', 'Brave', 'Not?A_Brand')],
        ['plain Chromium / Vivaldi', brands('Chromium', 'Not?A_Brand')],
        ['Yandex', brands('Chromium', 'YaBrowser', 'Google Chrome')],
        ['no userAgentData', undefined],
        ['empty brand list', []],
    ])('%s → false', (_label, list) => {
        expect(
            isGoogleChromeRuntime({
                buildBrowser: 'chrome',
                isSafari: false,
                brands: list,
            }),
        ).toBe(false)
    })

    it('the Safari conversion of the Chrome build → false, whatever brands say', () => {
        expect(
            isGoogleChromeRuntime({
                buildBrowser: 'chrome',
                isSafari: true,
                brands: chrome,
            }),
        ).toBe(false)
    })

    it.each(['firefox', 'safari', 'edge', undefined])(
        'a %s build → false',
        buildBrowser => {
            expect(
                isGoogleChromeRuntime({
                    buildBrowser,
                    isSafari: false,
                    brands: chrome,
                }),
            ).toBe(false)
        },
    )
})
