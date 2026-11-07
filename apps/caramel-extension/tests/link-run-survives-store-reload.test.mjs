import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// A discount-link run the store's own page reloads under (T-13322).
//
// neweracap.com, Firefox, 1.4.34 gate (2026-11-03): the theme reloaded the
// cart page at try 5 of 8, with FREE (-$55.99) already on the cart. The run
// died with the document: the shopper had the best code, no card, and the
// "Try Caramel" pill back as if nothing had run.
//
// Pinned here, with the real runner, the real handoff helpers and the real
// background store (only fetch(), the UI and the reload are faked):
//   · while it probes, the run keeps what it knows with the background
//   · the page after the reload carries on from the code it was on, with the
//     run's own start total, so our code on the cart is not taken for the
//     shopper's and the saving is still read off the cart
//   · a reload after the last code goes straight to the card
//   · nothing is left behind once a run ends on its own page
//   · a record is resumed once, never when stale or after ×

const handoffs = vi.hoisted(() => ({ bg: null }))
const stubs = vi.hoisted(() => ({ coupons: [], finalModals: [], wins: [] }))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        caramelTabHandoff: (op, key, value, expected) =>
            handoffs.bg.reply({ op, key, value, expected }),
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
    // The win path hands the result across our own reload; record it instead.
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

handoffs.bg = tabHandoffBackground()
const { startApplyingCoupons } = await import('../coupon-runner.js')
const { caramelHoldLinkRun, caramelTakeLinkRun } =
    await import('../dom-utils.js')
const { _markTriedCode } = await import('../coupon-apply.js')
const { _caramelResetCachedCodes } = await import('../store-detect.js')

const REC = { domain: 'shop.example' }
const codes = (...names) => names.map(n => ({ code: n, id: n.toLowerCase() }))

/** A Shopify cart: a code worth something replaces the live one. */
function makeCart({ subtotal, worth, live = null }) {
    const sentCodes = live ? [live] : []
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
let hold // the /discount/ code to hold open, and the release for it

/* Wires fetch() to `c`. The /discount/ request for `hold.code` stays open
 * until `hold.release()`: the moment the store's reload hits. */
function useStore(c, coupons) {
    cart = c
    stubs.coupons = coupons
    globalThis.fetch = path => {
        path = String(path)
        const code = path.startsWith('/discount/')
            ? decodeURIComponent(path.slice('/discount/'.length))
            : null
        if (code) sent.push(code)
        if (path === '/cart.js') {
            const body = cart.read()
            return Promise.resolve({ ok: true, json: async () => body })
        }
        if (code && hold?.code === code && !hold.released) {
            hold.reached = true
            return new Promise(resolve => {
                hold.release = () => {
                    hold.released = true
                    cart.apply(code)
                    resolve({ ok: true })
                }
            })
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

/* Moves fake time in steps until `done()` or `budgetMs` has passed. */
async function until(done, budgetMs = 120000) {
    for (let t = 0; t < budgetMs && !done(); t += 250)
        await vi.advanceTimersByTimeAsync(250)
    return done()
}
function run(options) {
    const r = { ended: false }
    startApplyingCoupons(REC, options).then(() => {
        r.ended = true
    })
    return r
}
const held = () => handoffs.bg.peek('link_run')

// What the page before the reload left: FREE best, codes 0 and 1 done.
const LEFT_AT_TRY_3 = {
    base: 5599,
    items: 1,
    planned: [
        { code: 'APP20', id: 'app20' },
        { code: 'FREE', id: 'free' },
        { code: 'AUG03', id: 'aug03' },
        { code: 'AUG08', id: 'aug08' },
    ],
    next: 2,
    bestCode: 'FREE',
    bestId: 'free',
    bestTotal: 0,
    currency: 'USD',
    arrivedWith: null,
    measured: 2,
    sawHollowDrop: false,
    resumed: false,
}

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    })
    sessionStorage.clear()
    document.body.innerHTML = ''
    stubs.finalModals = []
    stubs.wins = []
    sent = []
    hold = null
    handoffs.bg.reset()
    _caramelResetCachedCodes()
    globalThis._caramelCancelled = false
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

describe('while it probes', () => {
    it('keeps with the background what the next page would need', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { APP20: 1120, FREE: 5599 } }),
            codes('APP20', 'FREE', 'AUG03', 'AUG08'),
        )
        hold = { code: 'AUG03' }

        const r = run()
        expect(await until(() => hold.reached)).toBe(true)

        // The store reloads here: this is what the next page reads.
        const st = await held()
        expect(st).toMatchObject({
            base: 5599,
            items: 1,
            next: 2,
            bestCode: 'FREE',
            bestId: 'free',
            bestTotal: 0,
            arrivedWith: null,
            resumed: false,
        })
        expect(st.planned.map(c => c.code)).toEqual([
            'APP20',
            'FREE',
            'AUG03',
            'AUG08',
        ])

        hold.release()
        expect(await until(() => r.ended)).toBe(true)
    }, 30000)

    it('leaves nothing behind once it ends on its own page', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { APP20: 1120 } }),
            codes('APP20', 'AUG03'),
        )

        const r = run()
        expect(await until(() => r.ended)).toBe(true)

        expect(stubs.wins.map(w => w.code)).toEqual(['APP20'])
        expect(await held()).toBe(null)
    }, 30000)

    it('leaves nothing behind when it ends with no win', async () => {
        useStore(makeCart({ subtotal: 5599, worth: {} }), codes('AUG03'))

        const r = run()
        expect(await until(() => r.ended)).toBe(true)

        expect(stubs.wins).toEqual([])
        expect(stubs.finalModals).toHaveLength(1)
        expect(await held()).toBe(null)
    }, 30000)
})

describe('the page after the store reloaded', () => {
    it('carries on from the code it was on, and credits from the run start', async () => {
        // FREE is on the cart and the total reads $0.00. Read as a start,
        // that cart would make FREE "the shopper's code" and the saving $0.
        useStore(
            makeCart({
                subtotal: 5599,
                worth: { APP20: 1120, FREE: 5599 },
                live: 'FREE',
            }),
            codes('APP20', 'FREE', 'AUG03', 'AUG08'),
        )
        _markTriedCode('APP20')
        _markTriedCode('FREE')
        await caramelHoldLinkRun(LEFT_AT_TRY_3)

        const carry = await caramelTakeLinkRun()
        const r = run({ resumed: true, linkCarry: carry })
        expect(await until(() => r.ended)).toBe(true)

        // Codes 3 and 4, then FREE put back: not the list again from the top.
        expect(sent.slice(0, 2)).toEqual(['AUG03', 'AUG08'])
        expect(sent).not.toContain('APP20')
        expect(stubs.wins).toEqual([
            expect.objectContaining({ code: 'FREE', id: 'free', saved: 55.99 }),
        ])
        expect(await held()).toBe(null)
    }, 30000)

    it('goes straight to the card when every code was already tried', async () => {
        useStore(
            makeCart({
                subtotal: 5599,
                worth: { APP20: 1120, FREE: 5599 },
                live: 'APP20',
            }),
            codes('APP20', 'FREE'),
        )
        _markTriedCode('APP20')
        _markTriedCode('FREE')
        await caramelHoldLinkRun({
            ...LEFT_AT_TRY_3,
            planned: LEFT_AT_TRY_3.planned.slice(0, 2),
            next: 2,
        })

        const r = run({ resumed: true, linkCarry: await caramelTakeLinkRun() })
        expect(await until(() => r.ended)).toBe(true)

        // Only the winner goes back on; the saving is what the cart reads.
        expect(sent).toEqual(['FREE'])
        expect(stubs.wins).toEqual([
            expect.objectContaining({ code: 'FREE', saved: 55.99 }),
        ])
    }, 30000)

    it('a resumed run marks its record so it is not resumed a second time', async () => {
        useStore(
            makeCart({ subtotal: 5599, worth: { FREE: 5599 }, live: 'FREE' }),
            codes('APP20', 'FREE', 'AUG03', 'AUG08'),
        )
        _markTriedCode('APP20')
        _markTriedCode('FREE')
        await caramelHoldLinkRun(LEFT_AT_TRY_3)
        hold = { code: 'AUG03' }

        const r = run({ resumed: true, linkCarry: await caramelTakeLinkRun() })
        expect(await until(() => hold.reached)).toBe(true)

        // The store reloads again here.
        expect((await held()).resumed).toBe(true)

        hold.release()
        expect(await until(() => r.ended)).toBe(true)
    }, 30000)
})

describe('a record left for the next page', () => {
    it('is taken once', async () => {
        await caramelHoldLinkRun(LEFT_AT_TRY_3)

        expect(await caramelTakeLinkRun()).toMatchObject({
            next: 2,
            bestCode: 'FREE',
        })
        expect(await caramelTakeLinkRun()).toBe(null)
    })

    it('is not taken once it is stale', async () => {
        await caramelHoldLinkRun(LEFT_AT_TRY_3)
        await vi.advanceTimersByTimeAsync(121000)

        expect(await caramelTakeLinkRun()).toBe(null)
    })

    it('is not taken after the shopper pressed ×', async () => {
        await caramelHoldLinkRun(LEFT_AT_TRY_3)
        sessionStorage.setItem('caramel_run_stop', '1')

        expect(await caramelTakeLinkRun()).toBe(null)
    })

    it('is not taken when it is malformed', async () => {
        await caramelHoldLinkRun({ ...LEFT_AT_TRY_3, next: 9 })
        expect(await caramelTakeLinkRun()).toBe(null)

        await caramelHoldLinkRun({ ...LEFT_AT_TRY_3, planned: [] })
        expect(await caramelTakeLinkRun()).toBe(null)
    })
})
