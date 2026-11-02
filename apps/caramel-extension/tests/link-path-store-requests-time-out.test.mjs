import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    _caramelStoreFetch,
    _getTriedCodes,
    CARAMEL_STORE_REQUEST_MS,
    probeCartJson,
} from '../coupon-apply.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { _caramelResetCachedCodes } from '../store-detect.js'

// A store request that is never answered must not stop the run (T-12600).
//
// neweracap.com in Firefox, 1.4.32 (2026-11-02): the card stopped at "Trying
// coupon 6 of 8 (SAVE20)" and never moved. The discount-link path awaits each
// store request in turn and fetch() has no deadline, so one unanswered
// /discount/ request held the whole run forever. Every request on this path
// now has one, and a request that runs out of time is not read as "the code
// didn't apply": the store may have taken it, so the cart decides.
//
// Unlike own-code-survives-probing, nothing in coupon-apply.js is mocked here.
// The store is faked at fetch(), so the real request code, deadline included,
// is what runs. The deadline is shortened to 20 ms through AbortSignal.timeout;
// one test checks the real value is what reaches it.

const stubs = vi.hoisted(() => ({
    coupons: [],
    finalModals: [],
    wins: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    fetchCoupons: async () => stubs.coupons,
}))
vi.mock('../store-detect.js', async importOriginal => ({
    ...(await importOriginal()),
    getCachedCodes: async () => stubs.coupons,
}))
vi.mock('../dom-utils.js', async importOriginal => ({
    ...(await importOriginal()),
    // The win path hands the result across a reload; record it instead.
    caramelHoldAppliedWin: async win => {
        stubs.wins.push(win)
    },
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModals.push(args),
}))

const REC = { domain: 'shop.example' }

/** A Shopify cart as harney.com's was measured (see own-code-survives-probing):
 * /discount/{code} appends, a live code demotes the others, and re-sending an
 * attached code moves it to the end, dead. */
function makeCart({ subtotal, worth }) {
    const codes = []
    const value = () => {
        const live = codes.find(c => !c.dead)
        return live ? worth[live.code] || 0 : 0
    }
    return {
        read() {
            const discount = value()
            return {
                token: 't',
                item_count: 2,
                currency: 'USD',
                total_price: subtotal - discount,
                total_discount: discount,
                discount_codes: codes.map(c => ({
                    code: c.code,
                    applicable: !c.dead,
                })),
                cart_level_discount_applications: codes
                    .filter(c => !c.dead)
                    .map(c => ({
                        title: c.code,
                        total_allocated_amount: worth[c.code] || 0,
                    })),
            }
        },
        apply(code) {
            const already = codes.findIndex(c => c.code === code)
            if (already >= 0) {
                codes.splice(already, 1)
                codes.push({ code, dead: true })
            } else if (worth[code] > 0) {
                for (const c of codes) c.dead = true
                codes.push({ code, dead: false })
            } else {
                codes.push({ code, dead: true })
            }
        },
        clear() {
            codes.length = 0
        },
    }
}

let cart
let sent

/* Wires fetch() to `c`. `silent(path)` picks the requests the store never
 * answers, and what it does with them anyway:
 *   'ignores'  nothing happens on the store
 *   'takes'    the store applies the code at once, then never answers
 *   'later'    the store applies it only when the next /discount/ arrives,
 *              i.e. after we gave up on it and read the cart */
function useStore(c, coupons, silent = () => null) {
    cart = c
    stubs.coupons = coupons
    const landLater = []
    globalThis.fetch = (url, opts = {}) => {
        const path = String(url)
        const code = path.startsWith('/discount/')
            ? decodeURIComponent(path.slice('/discount/'.length))
            : null
        if (code) {
            sent.push(code)
            while (landLater.length) cart.apply(landLater.shift())
        }
        const how = silent(path)
        if (how) {
            if (code && how === 'takes') cart.apply(code)
            if (code && how === 'later') landLater.push(code)
            return new Promise((_, reject) => {
                const s = opts.signal
                if (!s) return // no deadline: this request never ends
                const fail = () =>
                    reject(s.reason ?? new DOMException('', 'AbortError'))
                if (s.aborted) fail()
                else s.addEventListener('abort', fail)
            })
        }
        if (path === '/cart.js') {
            const body = cart.read()
            return Promise.resolve({ ok: true, json: async () => body })
        }
        if (code) {
            cart.apply(code)
            return Promise.resolve({ ok: true })
        }
        if (path === '/cart/update.js') {
            cart.clear()
            return Promise.resolve({ ok: true })
        }
        return Promise.resolve({ ok: false, status: 404 })
    }
}

/* Resolves true when the run ends, false when it is still going after `ms`.
 * A run that hangs must fail the test, not hang the suite. */
async function runEnds(ms = 5000) {
    let timer
    const ended = await Promise.race([
        startApplyingCoupons(REC).then(() => true),
        new Promise(r => {
            timer = setTimeout(() => r(false), ms)
        }),
    ])
    clearTimeout(timer)
    return ended
}

const realTimeout = AbortSignal.timeout
beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    stubs.finalModals = []
    stubs.wins = []
    sent = []
    _caramelResetCachedCodes()
    globalThis._caramelCancelled = false
    AbortSignal.timeout = () => {
        const c = new AbortController()
        setTimeout(() => c.abort(new DOMException('', 'TimeoutError')), 20)
        return c.signal
    }
})
afterEach(() => {
    AbortSignal.timeout = realTimeout
    vi.useRealTimers()
})

const message = () => stubs.finalModals[0]?.[2] || ''
const listed = () => (stubs.finalModals[0]?.[4] || []).map(c => c.code)
const codes = (...names) => names.map(n => ({ code: n, id: n.toLowerCase() }))

describe('a store request that is never answered', () => {
    it('still ends the run with a card', async () => {
        useStore(
            makeCart({ subtotal: 11100, worth: {} }),
            codes('MAR26', 'SAVE20', 'HEMP23'),
            p => (p === '/discount/SAVE20' ? 'ignores' : null),
        )

        expect(await runEnds()).toBe(true)
        expect(stubs.finalModals).toHaveLength(1)
        expect(sent).toEqual(['MAR26', 'SAVE20', 'HEMP23'])
    }, 15000)

    it('does not count as a code that was tried and failed', async () => {
        // We learned nothing about it, so it stays in the shopper's list at
        // full rank, and the card cannot say every total was read.
        useStore(
            makeCart({ subtotal: 11100, worth: {} }),
            codes('MAR26', 'SAVE20', 'HEMP23'),
            p => (p === '/discount/SAVE20' ? 'ignores' : null),
        )

        await runEnds()

        expect(_getTriedCodes()).not.toHaveProperty('SAVE20')
        expect(message()).not.toMatch(/none lowered your total/)
    }, 15000)

    it('is credited when the store took the code anyway', async () => {
        useStore(
            makeCart({ subtotal: 11100, worth: { WIN15: 1500 } }),
            codes('MAR26', 'WIN15'),
            p => (p === '/discount/WIN15' ? 'takes' : null),
        )

        expect(await runEnds()).toBe(true)
        expect(stubs.wins.map(w => w.code)).toEqual(['WIN15'])
        expect(cart.read().total_discount).toBe(1500)
    }, 15000)

    it('gives the credit to the code that landed late, not the next one', async () => {
        // The store applies LATE15 after we gave up on it, so the drop shows
        // up on NEXTONE's cart read. The cart names LATE15 as the live code.
        useStore(
            makeCart({ subtotal: 11100, worth: { LATE15: 1500 } }),
            codes('LATE15', 'NEXTONE'),
            p => (p === '/discount/LATE15' ? 'later' : null),
        )

        expect(await runEnds()).toBe(true)
        // The handoff is what the reloaded page records in savings history
        // (caramelRecordSaving) and names on the card, so all four fields
        // have to be the live code's: its name, its catalog id, and the
        // amount read off the cart.
        expect(stubs.wins).toEqual([
            expect.objectContaining({
                code: 'LATE15',
                id: 'late15',
                saved: 15,
                currency: 'USD',
            }),
        ])
        expect(cart.read().total_discount).toBe(1500)
    }, 15000)

    it('ends the run when the cart itself stops answering', async () => {
        // Every read after the first: the run still ends, and with no card
        // that claims a saving.
        let reads = 0
        useStore(
            makeCart({ subtotal: 11100, worth: { WIN15: 1500 } }),
            codes('MAR26', 'WIN15'),
            p => (p === '/cart.js' && ++reads > 1 ? 'ignores' : null),
        )

        expect(await runEnds()).toBe(true)
        expect(stubs.wins).toEqual([])
        expect(stubs.finalModals).toHaveLength(1)
    }, 15000)
})

describe('the shopper arrived with their own code', () => {
    const CATALOGUE = codes('MAR26', 'SNOW26', 'HEMP23')

    it('keeps it, and says so, when a probe is never answered', async () => {
        const c = makeCart({ subtotal: 11100, worth: { HARNEY10: 1000 } })
        c.apply('HARNEY10')
        useStore(c, CATALOGUE, p =>
            p === '/discount/SNOW26' ? 'ignores' : null,
        )

        expect(await runEnds()).toBe(true)
        expect(cart.read().total_discount).toBe(1000)
        expect(sent).not.toContain('HARNEY10')
        expect(message()).toContain('HARNEY10 is already applied')
        expect(message()).toContain('10.00')
    }, 15000)

    it('puts it back when an unanswered probe knocked it off', async () => {
        // SNOW26 is live on the store and worth less; the store applied it
        // and never answered, which took HARNEY10 off the cart.
        const c = makeCart({
            subtotal: 11100,
            worth: { HARNEY10: 1000, SNOW26: 300 },
        })
        c.apply('HARNEY10')
        useStore(c, CATALOGUE, p => (p === '/discount/SNOW26' ? 'takes' : null))

        expect(await runEnds()).toBe(true)
        expect(cart.read().total_discount).toBe(1000)
        expect(message()).toContain('HARNEY10')
        expect(message()).toContain('10.00')
    }, 15000)

    it('tells them to paste it back when the put-back is never answered', async () => {
        const c = makeCart({
            subtotal: 11100,
            worth: { HARNEY10: 1000, SNOW26: 300 },
        })
        c.apply('HARNEY10')
        useStore(c, CATALOGUE, p =>
            p === '/discount/HARNEY10' ? 'ignores' : null,
        )

        expect(await runEnds()).toBe(true)
        expect(message()).not.toContain('already applied')
        expect(message()).not.toContain('saving you')
        expect(message()).toContain("couldn't put your HARNEY10 back")
        expect(listed()[0]).toBe('HARNEY10')
    }, 15000)

    it('ends honestly when the clear is never answered either', async () => {
        const c = makeCart({
            subtotal: 11100,
            worth: { HARNEY10: 1000, SNOW26: 300 },
        })
        c.apply('HARNEY10')
        useStore(c, CATALOGUE, p =>
            p === '/discount/HARNEY10' || p === '/cart/update.js'
                ? 'ignores'
                : null,
        )

        expect(await runEnds()).toBe(true)
        expect(message()).not.toContain('saving you')
        expect(message()).toContain('HARNEY10')
    }, 15000)
})

describe('the deadline itself', () => {
    it('is ten seconds, and reaches the request', async () => {
        const asked = []
        AbortSignal.timeout = ms => {
            asked.push(ms)
            return new AbortController().signal
        }
        let seen
        globalThis.fetch = async (_url, opts) => {
            seen = opts.signal
            return { ok: true }
        }

        await _caramelStoreFetch('/cart.js', { credentials: 'same-origin' })

        expect(CARAMEL_STORE_REQUEST_MS).toBe(10000)
        expect(asked).toEqual([10000])
        expect(seen).toBeInstanceOf(AbortSignal)
    })

    it('still applies where AbortSignal.timeout does not exist', async () => {
        // Safari 15 has AbortController but not AbortSignal.timeout.
        delete AbortSignal.timeout
        vi.useFakeTimers()
        globalThis.fetch = (_url, opts) =>
            new Promise((_, reject) =>
                opts.signal.addEventListener('abort', () =>
                    reject(new DOMException('', 'AbortError')),
                ),
            )

        let done = false
        const read = probeCartJson().then(r => {
            done = true
            return r
        })
        await vi.advanceTimersByTimeAsync(CARAMEL_STORE_REQUEST_MS - 1)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1)

        expect(await read).toBeNull()
    })

    it('covers a body that stops arriving', async () => {
        // The response came, then the body never finished: r.json() is the
        // same hang, and the same deadline ends it.
        globalThis.fetch = async (_url, opts) => ({
            ok: true,
            json: () =>
                new Promise((_, reject) =>
                    // No signal: the body never finishes.
                    opts?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('', 'AbortError')),
                    ),
                ),
        })

        const ended = await Promise.race([
            probeCartJson().then(r => ({ r })),
            new Promise(r => setTimeout(() => r(null), 2000)),
        ])
        expect(ended).toEqual({ r: null })
    })
})
