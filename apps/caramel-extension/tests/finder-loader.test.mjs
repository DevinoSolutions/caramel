import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    _caramelResetDiscoveryOn,
    _caramelResetFinderLoad,
    caramelCouponBoxDiscoveryOn,
    caramelLoadedFinder,
    caramelLoadFinder,
} from '../coupon-box-finder-loader.js'
import {
    FINDER_FLAG_MEMORY_KEY,
    finderFlagFromMemory,
} from '../finder-flag-memory.js'
import { EXT_ROOT } from './_entry-modules.mjs'

// The content script's loader for the promo-box finder. A finder that cannot
// be used is a finder that found nothing (null, never a throw), and a shipped
// build must still be able to see that it happened: log() is silent there,
// so the failure goes through logError, once per page.

const { errors, browser, timings, asks, worker } = vi.hoisted(() => ({
    errors: [],
    browser: { getURL: () => '' },
    timings: [],
    // Every flag question: the wait it was given.
    asks: [],
    // What the background does with each question, in order: an answer
    // object, or an Error for a question it never answered.
    worker: {
        replies: [],
        memory: undefined,
        memoryHangs: false,
        memoryThrows: false,
    },
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return {
                runtime: { getURL: p => browser.getURL(p), lastError: null },
                storage: {
                    local: {
                        get: (keys, cb) => {
                            if (worker.memoryThrows)
                                throw new Error(
                                    'Extension context invalidated.',
                                )
                            if (worker.memoryHangs) return
                            cb({ [keys[0]]: worker.memory })
                        },
                    },
                },
            }
        },
        caramelSendMessage: async (_message, waitMs) => {
            asks.push(waitMs)
            const reply = worker.replies.shift()
            if (reply instanceof Error) throw reply
            return reply
        },
        recordTiming: (event, meta) => timings.push([event, meta]),
        logError: (where, err) =>
            errors.push([where, String(err?.message || err)]),
    }
})

const fixture = name =>
    pathToFileURL(join(EXT_ROOT, 'tests', 'fixtures', 'finder-loader', name))
        .href

beforeEach(() => {
    errors.length = 0
    timings.length = 0
    asks.length = 0
    worker.replies = []
    worker.memory = undefined
    worker.memoryHangs = false
    worker.memoryThrows = false
    _caramelResetFinderLoad()
    _caramelResetDiscoveryOn()
})

describe('the finder loader', () => {
    it('a finder that takes the hand-over is loaded, once, and given the helpers', async () => {
        let asked = 0
        browser.getURL = () => {
            asked++
            return fixture('finder-ok.mjs')
        }
        const m = await caramelLoadFinder()
        await caramelLoadFinder()
        expect(asked).toBe(1)
        expect(caramelLoadedFinder()).toBe(m)
        expect(typeof m.handedOver.log).toBe('function')
        expect(typeof m.handedOver.getPrice).toBe('function')
        expect(errors).toEqual([])
    })

    it('a module with no hand-over is not loaded: null, and the failure is reported', async () => {
        browser.getURL = () => fixture('finder-no-handover.mjs')
        expect(await caramelLoadFinder()).toBeNull()
        expect(caramelLoadedFinder()).toBeNull()
        expect(errors).toEqual([
            ['FINDER_LOAD_FAILED', 'the finder module has no host hand-over'],
        ])
    })

    for (const [name, getURL] of [
        ['a file that is not there', () => fixture('no-such-finder.mjs')],
        [
            'an extension URL that cannot be built',
            () => {
                throw new Error('Extension context invalidated.')
            },
        ],
    ])
        it(`${name}: null, reported once however often the page asks`, async () => {
            browser.getURL = getURL
            const answers = await Promise.all([
                caramelLoadFinder(),
                caramelLoadFinder(),
            ])
            answers.push(await caramelLoadFinder())
            expect(answers).toEqual([null, null, null])
            expect(errors).toHaveLength(1)
            expect(errors[0][0]).toBe('FINDER_LOAD_FAILED')
        })
})

// T-10668: on a loaded machine the background left the flag question
// unanswered for the page's whole 15s wait, and that one silence turned the
// finder off for the page (keenfootwear.com, eq3.com, neweracap.com). The
// page now asks again, then falls back on the last flag the server gave.
const silence = () =>
    new Error(
        'caramel: no response to "couponBoxDiscoveryEnabled" within 15000ms',
    )

describe('the finder flag, when the background does not answer', () => {
    const NOW = 1_800_000_000_000
    const remembered = (on, ageMs) => ({ on, ts: NOW - ageMs })

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
        vi.setSystemTime(NOW)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('a background that answers is asked once, with the usual wait, and nothing is recorded', async () => {
        worker.replies = [{ enabled: true }]

        expect(await caramelCouponBoxDiscoveryOn()).toBe(true)
        expect(await caramelCouponBoxDiscoveryOn()).toBe(true)
        expect(asks).toEqual([undefined])
        expect(timings).toEqual([])
    })

    it('a real "off" is an answer: not asked again', async () => {
        worker.replies = [{ enabled: false }]

        expect(await caramelCouponBoxDiscoveryOn()).toBe(false)
        expect(asks).toEqual([undefined])
    })

    it('no answer the first time: asked once more with a 5s wait, and that answer counts', async () => {
        worker.replies = [silence(), { enabled: true }]

        expect(await caramelCouponBoxDiscoveryOn()).toBe(true)
        expect(asks).toEqual([undefined, 5000])
        expect(timings).toEqual([])
    })

    it('no answer twice: the remembered "on" from 10 minutes ago is used, and the failure recorded', async () => {
        worker.replies = [silence(), new Error('port closed')]
        worker.memory = remembered(true, 10 * 60 * 1000)

        expect(await caramelCouponBoxDiscoveryOn()).toBe(true)
        expect(timings).toEqual([
            [
                'FINDER_FLAG_UNREADABLE',
                {
                    error: 'Error: port closed',
                    first: String(silence()),
                    remembered: true,
                },
            ],
        ])
    })

    it('no answer twice and a remembered "on" 31 minutes old: off, so the kill switch still holds', async () => {
        worker.replies = [silence(), silence()]
        worker.memory = remembered(true, 31 * 60 * 1000)

        expect(await caramelCouponBoxDiscoveryOn()).toBe(false)
        expect(timings[0][1].remembered).toBeNull()
    })

    it('no answer twice and nothing remembered: off, and recorded', async () => {
        worker.replies = [silence(), silence()]

        expect(await caramelCouponBoxDiscoveryOn()).toBe(false)
        expect(timings).toHaveLength(1)
        expect(timings[0][0]).toBe('FINDER_FLAG_UNREADABLE')
    })

    it('a remembered "off" is off', async () => {
        worker.replies = [silence(), silence()]
        worker.memory = remembered(false, 60 * 1000)

        expect(await caramelCouponBoxDiscoveryOn()).toBe(false)
        expect(timings[0][1].remembered).toBe(false)
    })

    it('a memory read that never answers costs 3s, then off', async () => {
        worker.replies = [silence(), silence()]
        worker.memoryHangs = true
        let on = 'pending'
        caramelCouponBoxDiscoveryOn().then(v => {
            on = v
        })

        await vi.advanceTimersByTimeAsync(2999)
        expect(on).toBe('pending')
        await vi.advanceTimersByTimeAsync(1)
        expect(on).toBe(false)
        expect(timings[0][1].remembered).toBeNull()
    })

    it('a memory that cannot be read: off, and the reason recorded', async () => {
        worker.replies = [silence(), silence()]
        worker.memoryThrows = true

        expect(await caramelCouponBoxDiscoveryOn()).toBe(false)
        expect(errors).toEqual([
            ['FINDER_FLAG_MEMORY_UNREADABLE', 'Extension context invalidated.'],
        ])
        expect(timings[0][1].remembered).toBeNull()
    })

    it('asked once per page however the asking went', async () => {
        worker.replies = [silence(), silence()]

        await Promise.all([
            caramelCouponBoxDiscoveryOn(),
            caramelCouponBoxDiscoveryOn(),
        ])
        await caramelCouponBoxDiscoveryOn()
        expect(asks).toHaveLength(2)
        expect(timings).toHaveLength(1)
    })
})

describe('finderFlagFromMemory: what counts as a remembered flag', () => {
    const NOW = 1_800_000_000_000
    for (const [name, record, want] of [
        ['fresh on', { on: true, ts: NOW - 1000 }, true],
        ['fresh off', { on: false, ts: NOW - 1000 }, false],
        [
            'exactly 30 minutes old',
            { on: true, ts: NOW - 30 * 60 * 1000 },
            null,
        ],
        [
            'from the future (a clock moved back)',
            { on: true, ts: NOW + 1000 },
            null,
        ],
        ['"true" the string', { on: 'true', ts: NOW }, null],
        ['no timestamp', { on: true }, null],
        ['nothing stored', undefined, null],
    ])
        it(`${name}: ${want}`, () => {
            expect(finderFlagFromMemory(record, NOW)).toBe(want)
        })

    it('lives under its own storage key', () => {
        expect(FINDER_FLAG_MEMORY_KEY).toBe('caramel_finder_flag')
    })
})
