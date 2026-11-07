import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    CARAMEL_LINK_TRY_MS,
    CARAMEL_SETTLE_FULL_MS,
    caramelCreditSettles,
    startApplyingCoupons,
} from '../coupon-runner.js'
import { _caramelResetCachedCodes } from '../store-detect.js'

// The discount-link run must always end with a card (1.4.33, 2026-11-03).
//
// neweracap.com, Chrome and Firefox, in the 1.4.33 store gate: the card sat
// on "Trying coupon 8 of 8 (1UBYMI38)" for 187 s and 200+ s and never
// finished. The best code was FREE, a $0 order, the one case that holds its
// credit for the full settle window. That window was counted in loop turns
// (a 500ms sleep and a cart read each), so a page whose timers the browser
// held back (the window sat behind others on a loaded machine) stretched every
// turn: the cart was read 0.7 s, 13 s, 46 s, 73 s apart. A second run, same
// store, ended in 30 s with "You saved $55.99". Alongside it, two /discount/
// requests were open at once: fetch() resolves on the redirected page's
// headers and its body went on loading under the next codes.
//
// Pinned here: the settle window ends by the clock and a strike it cannot
// confirm cannot hold it open; a run under held-back timers still ends; a try
// whose request never ends is capped; every /discount/ body is stopped before
// the next code is sent.

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
const codes = (...names) => names.map(n => ({ code: n, id: n.toLowerCase() }))

/** A Shopify cart: a code worth something replaces the live one. */
function makeCart({ subtotal, worth }) {
    let live = null
    const sentCodes = []
    return {
        read() {
            const discount = live ? worth[live] || 0 : 0
            return {
                token: 't',
                item_count: 1,
                currency: 'USD',
                total_price: subtotal - discount,
                total_discount: discount,
                discount_codes: sentCodes.map(c => ({
                    code: c,
                    applicable: c === live,
                })),
                cart_level_discount_applications: live
                    ? [{ title: live, total_allocated_amount: discount }]
                    : [],
            }
        },
        apply(code) {
            if (!sentCodes.includes(code)) sentCodes.push(code)
            if (worth[code] > 0) live = code
        },
        clear() {
            live = null
            sentCodes.length = 0
        },
    }
}

let cart
let sent
let bodiesOpen

/* Wires fetch() to `c`. Every /discount/ answer carries a body that stays
 * open until it is cancelled, like the storefront page the redirect lands on.
 * `stuck(path)`: a request that never ends and ignores its deadline. */
function useStore(c, coupons, stuck = () => false) {
    cart = c
    stubs.coupons = coupons
    globalThis.fetch = path => {
        path = String(path)
        const code = path.startsWith('/discount/')
            ? decodeURIComponent(path.slice('/discount/'.length))
            : null
        if (code) sent.push({ code, open: [...bodiesOpen] })
        if (stuck(path)) return new Promise(() => {})
        if (path === '/cart.js') {
            const body = cart.read()
            return Promise.resolve({ ok: true, json: async () => body })
        }
        if (code) {
            cart.apply(code)
            bodiesOpen.add(code)
            return Promise.resolve({
                ok: true,
                body: {
                    cancel: async () => {
                        bodiesOpen.delete(code)
                    },
                },
            })
        }
        if (path === '/cart/update.js') {
            cart.clear()
            return Promise.resolve({ ok: true })
        }
        return Promise.resolve({ ok: false, status: 404 })
    }
}

/* Fake time, moved in steps so the run's own awaits get their turns. Every
 * timer the page sets fires no sooner than `heldMs`: a browser holding back a
 * page's timers. Resolves true when the run ends within `budgetMs`. */
async function runEndsWithin(budgetMs, heldMs = 0) {
    const fakeSetTimeout = globalThis.setTimeout
    if (heldMs)
        globalThis.setTimeout = (fn, ms, ...args) =>
            fakeSetTimeout(fn, Math.max(ms || 0, heldMs), ...args)
    let ended = false
    startApplyingCoupons(REC).then(() => {
        ended = true
    })
    for (let t = 0; t < budgetMs && !ended; t += 250)
        await vi.advanceTimersByTimeAsync(250)
    globalThis.setTimeout = fakeSetTimeout
    return ended
}

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
    })
    sessionStorage.clear()
    document.body.innerHTML = ''
    stubs.finalModals = []
    stubs.wins = []
    sent = []
    bodiesOpen = new Set()
    _caramelResetCachedCodes()
    globalThis._caramelCancelled = false
    // The request deadline on the fake clock (the real one ignores it).
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const c = new AbortController()
        setTimeout(() => c.abort(new DOMException('', 'TimeoutError')), ms)
        return c.signal
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('the settle window', () => {
    // A drop that holds, read the way a held-back page reads it.
    it('ends by the clock when every read is slow', async () => {
        let reads = 0
        const read = () =>
            new Promise(r =>
                setTimeout(() => {
                    reads++
                    r({ total: 0, named: true })
                }, 30000),
            )
        let result
        caramelCreditSettles({
            code: 'FREE',
            from: 5599,
            total: 0,
            checkTotal: true,
            wasNamed: true,
            read,
            windowMs: CARAMEL_SETTLE_FULL_MS,
        }).then(r => {
            result = r
        })

        // One slow read is past the 8 s window. Counted in turns, the window
        // took 16 of them: eight minutes here.
        for (let t = 0; t < 60000 && !result; t += 500)
            await vi.advanceTimersByTimeAsync(500)

        expect(result).toEqual({ held: true, total: 0 })
        expect(reads).toBe(1)
    })

    it('a strike nothing can confirm does not hold it open', async () => {
        // The drop read as gone once, then the cart could not be read again.
        let n = 0
        const read = async () =>
            n++ === 0 ? { total: 5599, named: false } : null
        let result
        caramelCreditSettles({
            code: 'FREE',
            from: 5599,
            total: 0,
            checkTotal: true,
            wasNamed: true,
            read,
            windowMs: CARAMEL_SETTLE_FULL_MS,
        }).then(r => {
            result = r
        })

        for (let t = 0; t < 30000 && !result; t += 500)
            await vi.advanceTimersByTimeAsync(500)

        // Not claimed: the last thing the store showed was the saving gone.
        expect(result).toEqual({ held: false, total: 5599 })
    })

    it('a reversal the store confirms is still a reversal', async () => {
        const read = async () => ({ total: 5599, named: false })
        let result
        caramelCreditSettles({
            code: 'FREE',
            from: 5599,
            total: 0,
            checkTotal: true,
            wasNamed: true,
            read,
            windowMs: CARAMEL_SETTLE_FULL_MS,
        }).then(r => {
            result = r
        })

        await vi.advanceTimersByTimeAsync(2000)

        expect(result).toEqual({ held: false, total: 5599 })
    })

    it('a drop that holds the whole window is held', async () => {
        let reads = 0
        const read = async () => {
            reads++
            return { total: 0, named: true }
        }
        let result
        caramelCreditSettles({
            code: 'FREE',
            from: 5599,
            total: 0,
            checkTotal: true,
            wasNamed: true,
            read,
            windowMs: CARAMEL_SETTLE_FULL_MS,
        }).then(r => {
            result = r
        })

        await vi.advanceTimersByTimeAsync(CARAMEL_SETTLE_FULL_MS + 1000)

        expect(result).toEqual({ held: true, total: 0 })
        expect(reads).toBe(CARAMEL_SETTLE_FULL_MS / 500)
    })
})

describe('a discount-link run ends with a card', () => {
    it('when the best code is a $0 order and the page timers are held back', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { APP20: 1120, FREE: 5599 } }),
            codes('APP20', 'FREE', '1UBYMI38'),
        )

        // Every timer at least 20 s apart. Counted in turns, the settle
        // window alone needed 16 of them here.
        expect(await runEndsWithin(240000, 20000)).toBe(true)
        expect(stubs.wins.map(w => w.code)).toEqual(['FREE'])
    }, 30000)

    it('when one try never ends, even past its own request deadlines', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { APP20: 1120 } }),
            codes('APP20', 'AUG08', '1UBYMI38'),
            p => p === '/discount/AUG08',
        )

        expect(await runEndsWithin(CARAMEL_LINK_TRY_MS * 3)).toBe(true)
        expect(sent.map(s => s.code)).toEqual(
            expect.arrayContaining(['APP20', 'AUG08', '1UBYMI38']),
        )
        expect(stubs.wins.map(w => w.code)).toEqual(['APP20'])
    }, 30000)

    it('stops each /discount/ page before the next code is sent', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { APP20: 1120 } }),
            codes('APP20', '5QD572J2', 'FREESHIP', 'AUG03'),
        )

        expect(await runEndsWithin(120000)).toBe(true)
        expect(sent.length).toBeGreaterThanOrEqual(4)
        for (const s of sent) expect(s.open).toEqual([])
        expect([...bodiesOpen]).toEqual([])
    }, 30000)
})
