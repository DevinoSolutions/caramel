import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// Pins for the fleet-silence root cause (measured live 2026-08-07): the
// service worker's fetch of the 1.14 MB supported-stores payload lost a race
// against its own 8 s abort, the abort was reported downstream as an EMPTY
// list rather than an error, and the content-script sendMessage waits had no
// timeout and never read runtime.lastError — so both an aborted fetch and an
// evicted worker rendered exactly like "this store isn't supported": total
// silence, no diagnostics, on a store with coupons. The background half of
// the fix is pinned in background-bulk-budget.test.mjs (separate realm).
// Every pin below fails against the pre-fix code.

let caramelSendMessage
let getDomainRecord

beforeAll(() => {
    // Spies must exist BEFORE the load: caramel-base.js only installs its own
    // recordTiming/logError fallbacks when the names are undefined, so these
    // become the functions the code under test calls.
    globalThis.recordTiming = vi.fn()
    globalThis.logError = vi.fn()
    ;({ caramelSendMessage, getDomainRecord } = loadExtensionSources(
        ['caramel-base.js', 'dom-utils.js', 'store-detect.js'],
        ['caramelSendMessage', 'getDomainRecord'],
    ))
})

let sendMessageCalls
let responses
let storedData

beforeEach(() => {
    globalThis.recordTiming.mockClear()
    globalThis.logError.mockClear()
    getDomainRecord.cache = null
    sendMessageCalls = 0
    responses = []
    storedData = {}
    globalThis.currentBrowser.runtime.lastError = undefined
    // Prod-TTL path (the stub is not a dev install): storage.local is read
    // before the API, and written back on a successful load.
    globalThis.currentBrowser.storage.local.get = (_keys, cb) =>
        cb({ ...storedData })
    globalThis.currentBrowser.storage.local.set = items =>
        Object.assign(storedData, items)
    // Each send consumes the next scripted response (last one repeats). A
    // function entry runs instead, to script lastError around the callback.
    globalThis.currentBrowser.runtime.sendMessage = (_msg, cb) => {
        const next =
            responses[Math.min(sendMessageCalls, responses.length - 1)]
        sendMessageCalls++
        if (typeof next === 'function') next(cb)
        else cb(next)
    }
})

afterEach(() => {
    vi.useRealTimers()
})

describe('caramel-base.js caramelSendMessage — a worker that cannot answer is an error, never a fake reply', () => {
    it('resolves with the response the worker actually sent', async () => {
        responses = [{ coupons: [{ code: 'SAVE10' }] }]
        await expect(
            caramelSendMessage({ action: 'fetchCoupons' }),
        ).resolves.toEqual({ coupons: [{ code: 'SAVE10' }] })
    })

    it('rejects when the port closed (runtime.lastError set) instead of resolving undefined', async () => {
        responses = [
            cb => {
                globalThis.currentBrowser.runtime.lastError = {
                    message:
                        'The message port closed before a response was received.',
                }
                cb(undefined)
                globalThis.currentBrowser.runtime.lastError = undefined
            },
        ]
        await expect(
            caramelSendMessage({ action: 'fetchCoupons' }),
        ).rejects.toThrow(/port closed/)
    })

    it('rejects on an undefined response even without lastError', async () => {
        responses = [undefined]
        await expect(
            caramelSendMessage({ action: 'fetchCoupons' }),
        ).rejects.toThrow(/no response/)
    })

    it('rejects after its budget when nothing ever answers, instead of hanging forever', async () => {
        vi.useFakeTimers()
        responses = [
            () => {
                /* worker never calls back — the pre-fix promise never settled */
            },
        ]
        const p = caramelSendMessage({ action: 'fetchCoupons' })
        const outcome = expect(p).rejects.toThrow(/within \d+ms/)
        await vi.advanceTimersByTimeAsync(20000)
        await outcome
    })

    it('a late callback after the timeout does not double-settle', async () => {
        vi.useFakeTimers()
        let lateCb
        responses = [
            cb => {
                lateCb = cb
            },
        ]
        const p = caramelSendMessage({ action: 'fetchCoupons' })
        const outcome = expect(p).rejects.toThrow(/within \d+ms/)
        await vi.advanceTimersByTimeAsync(20000)
        await outcome
        expect(() => lateCb({ coupons: [] })).not.toThrow()
    })
})

describe('store-detect.js getDomainRecord — "we could not ask" is not "not supported"', () => {
    const REC = { domain: 'example.com', couponInput: '#promo' }

    async function callThroughRetry(domain) {
        vi.useFakeTimers()
        const p = getDomainRecord(domain)
        // Covers the retry backoff (750 ms) with margin.
        await vi.advanceTimersByTimeAsync(5000)
        vi.useRealTimers()
        return p
    }

    it('a worker-reported failure is retried, and the retry answer is used', async () => {
        responses = [
            { supported: [], error: 'AbortError: signal is aborted' },
            { supported: [REC] },
        ]
        const rec = await callThroughRetry('example.com')
        expect(rec).toEqual(REC)
        expect(sendMessageCalls).toBe(2)
        // The good answer must land in the persistent cache like any load.
        expect(storedData.caramel_supported_stores?.data).toEqual([REC])
    })

    it('failure on every attempt is recorded loudly and falls back to the expired cache', async () => {
        storedData.caramel_supported_stores = {
            data: [REC],
            ts: Date.now() - 100 * 60 * 60 * 1000, // long expired
        }
        responses = [{ supported: [], error: 'AbortError' }]
        const rec = await callThroughRetry('example.com')
        expect(rec).toEqual(REC) // expired data beats silence
        expect(sendMessageCalls).toBe(2) // both attempts spent
        expect(globalThis.recordTiming).toHaveBeenCalledWith(
            'STORE_LIST_FETCH_FAILED',
            expect.objectContaining({
                error: expect.stringContaining('Abort'),
            }),
        )
        expect(globalThis.logError).toHaveBeenCalled()
    })

    it('failure with no cache at all records the failure and leaves the cache unpoisoned', async () => {
        responses = [{ supported: [], error: 'AbortError' }]
        const rec = await callThroughRetry('example.com')
        expect(rec).toBeUndefined()
        expect(globalThis.recordTiming).toHaveBeenCalledWith(
            'STORE_LIST_FETCH_FAILED',
            expect.anything(),
        )
        // Unpoisoned: a later call may still succeed; nothing was persisted.
        expect(getDomainRecord.cache).toBeNull()
        expect(storedData.caramel_supported_stores).toBeUndefined()
    })

    it('an empty-but-successful answer is a real answer: no retry, nothing recorded as failure', async () => {
        responses = [{ supported: [] }]
        const rec = await callThroughRetry('example.com')
        expect(rec).toBeUndefined()
        expect(sendMessageCalls).toBe(1)
        expect(globalThis.recordTiming).not.toHaveBeenCalledWith(
            'STORE_LIST_FETCH_FAILED',
            expect.anything(),
        )
    })

    it('a closed port on send is treated exactly like a worker-reported failure', async () => {
        storedData.caramel_supported_stores = {
            data: [REC],
            ts: Date.now() - 100 * 60 * 60 * 1000,
        }
        responses = [
            cb => {
                globalThis.currentBrowser.runtime.lastError = {
                    message:
                        'The message port closed before a response was received.',
                }
                cb(undefined)
                globalThis.currentBrowser.runtime.lastError = undefined
            },
        ]
        const rec = await callThroughRetry('example.com')
        expect(rec).toEqual(REC)
        expect(globalThis.recordTiming).toHaveBeenCalledWith(
            'STORE_LIST_FETCH_FAILED',
            expect.objectContaining({
                error: expect.stringContaining('port closed'),
            }),
        )
    })
})
