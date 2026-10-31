import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { applyCoupon } from '../coupon-apply.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    TOTAL,
    handoffs,
    installChromeStub,
    registerFinder,
    sent,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// A store whose refusal stays on the page between codes (T-11368).
// fullsource.com on 1.4.30, 2026-10-31: the finder picked #CouponCodeInput and
// the store answered every refused code with "This coupon code has expired or
// is invalid", in the same place. From the third code on that text was already
// there before the submit, so it read as the store's furniture
// (AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE) and each refused code waited out the
// whole ~10.5s window. The 41s run budget was spent before FREESHIP, the code
// that worked.
//
// A refusal the store gave an earlier code and puts up AGAIN after this
// submit is its answer to this code: the node replaced, its text set again
// (even to the same words), or shown after being hidden. Only what the store
// draws from the click on counts; a store that does not touch the old text,
// or only changes some other attribute, has not answered; and words it never
// gave as an answer stay furniture however often it draws them.

let logCalls

vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        log: (...args) => logCalls.push(args),
    }
})

// A refused code with no answer waits out the 10s window.
const SLOW = 20000
// What an answered refusal costs: the answer, the 1.5s grace for the total
// and a settle read. Main took the whole 10s window instead.
const ANSWERED_WITHIN_MS = 4000

const REFUSAL = 'This coupon code has expired or is invalid'

// The box, and the place under it where the store answers.
const BOX =
    '<div class="promo"><label for="CouponCodeInput">Coupon code</label>' +
    '<input id="CouponCodeInput" name="CouponCode" type="text">' +
    '<button id="ap" type="button">Apply</button>' +
    '<div id="msg" class="error"></div></div>'

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
    registerFinder()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    sent.length = 0
    setPath('/checkout')
    logCalls = []
    _caramelResetDiscoveryFlag()
    document.body.innerHTML = BOX + TOTAL
})

const msg = () => document.getElementById('msg')
const later = (fn, ms = 300) => setTimeout(fn, ms)

/* The store refuses the first code by writing its sentence into `el`, and
 * every later code by `again(n)` (n = 2, 3, …): the sentence is still showing
 * when each later code is submitted. Returns each attempt's result and time. */
async function refusedCodes(again, codes = ['MV15', 'ASFSP15'], el = msg) {
    let clicks = 0
    document.getElementById('ap').addEventListener('click', () => {
        clicks++
        if (clicks === 1) later(() => (el().textContent = REFUSAL))
        else again(clicks)
    })
    const rec = await caramelDiscoveredRecord(NO_CONFIG)
    expect(rec?.caramelFound).toBe(true)
    const tries = []
    for (const code of codes) {
        logCalls = []
        const startedAt = performance.now()
        const res = await applyCoupon(code, rec)
        tries.push({ res, ms: performance.now() - startedAt })
    }
    // The first refusal is new text on the page: answered as before.
    expect(tries[0].res.errorIsNew).toBe(true)
    return tries
}

const loggedNotAttributable = () =>
    logCalls.some(l => l[0] === 'AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE')

describe("the store's refusal, still showing, drawn again for the next code", () => {
    it(
        'its text set again to the same words ends the attempt on the answer',
        async () => {
            const [, next] = await refusedCodes(() =>
                later(() => (msg().textContent = REFUSAL)),
            )

            expect(next.res.success).toBe(false)
            expect(next.res.errorMsg).toBe(REFUSAL)
            expect(next.res.errorIsNew).toBe(true)
            expect(loggedNotAttributable()).toBe(false)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )

    it(
        'its node replaced by a new one with the same words ends the attempt on the answer',
        async () => {
            const [, next] = await refusedCodes(() => {
                later(() => msg().remove(), 100)
                later(() => {
                    const fresh = document.createElement('div')
                    fresh.id = 'msg'
                    fresh.className = 'error'
                    fresh.textContent = REFUSAL
                    document.querySelector('.promo').appendChild(fresh)
                })
            })

            expect(next.res.errorMsg).toBe(REFUSAL)
            expect(next.res.errorIsNew).toBe(true)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )

    it(
        'its text node rewritten in place ends the attempt on the answer',
        async () => {
            const [, next] = await refusedCodes(() =>
                later(() => (msg().firstChild.data = REFUSAL)),
            )

            expect(next.res.errorIsNew).toBe(true)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )

    it(
        'hidden as the store works and shown again with its answer ends the attempt on the answer',
        async () => {
            const [, next] = await refusedCodes(() => {
                msg().style.display = 'none'
                later(() => (msg().style.display = ''))
            })

            expect(next.res.errorMsg).toBe(REFUSAL)
            expect(next.res.errorIsNew).toBe(true)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )

    it(
        'shown again by dropping the hidden attribute and a hiding class ends the attempt on the answer',
        async () => {
            const [, next] = await refusedCodes(() => {
                msg().className = 'error is-hidden'
                msg().hidden = true
                later(() => {
                    msg().hidden = false
                    msg().className = 'error'
                })
            })

            expect(next.res.errorIsNew).toBe(true)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )

    it(
        'in a page alert whose text the store sets again, ends the attempt on the answer',
        async () => {
            // Six wrappers: the alert sits beyond the box's own area.
            document.body.innerHTML =
                '<div id="alert" role="alert"></div>' +
                '<div><div><div><div><div><div>' +
                BOX +
                TOTAL +
                '</div></div></div></div></div></div>'
            const alert = () => document.getElementById('alert')
            const [, next] = await refusedCodes(
                () => later(() => (alert().textContent = REFUSAL)),
                ['MV15', 'ASFSP15'],
                alert,
            )

            expect(next.res.errorMsg).toBe(REFUSAL)
            expect(next.res.errorIsNew).toBe(true)
            expect(next.ms).toBeLessThan(ANSWERED_WITHIN_MS)
        },
        SLOW,
    )
})

describe('words the store does not draw again for this code', () => {
    it('a refusal re-drawn as the code was typed, with only a busy class after the click, is not the answer', async () => {
        const input = document.getElementById('CouponCodeInput')
        const box = document.querySelector('.promo')
        await refusedCodes(() => {
            box.classList.add('is-loading')
            later(() => box.classList.remove('is-loading'))
        }, ['MV15'])
        // From the next code on, the box re-renders on every keystroke.
        input.addEventListener('input', () => {
            msg().textContent = REFUSAL
        })
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        logCalls = []
        const startedAt = performance.now()
        const res = await applyCoupon('ASFSP15', rec)

        expect(res.success).toBe(false)
        expect(res.errorIsNew).toBe(false)
        expect(loggedNotAttributable()).toBe(true)
        expect(performance.now() - startedAt).toBeGreaterThan(9000)
    }, 30000)

    it(
        'standing words the store never gave as an answer stay furniture, however often it draws them',
        async () => {
            // A store that re-draws its promo section on every submit brings
            // its standing text along. Never an answer to a code: not one now.
            const STANDING = 'Gift cards are not valid with promo codes'
            msg().textContent = STANDING
            document
                .getElementById('ap')
                .addEventListener('click', () =>
                    later(() => (msg().textContent = STANDING)),
                )
            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const startedAt = performance.now()
            const res = await applyCoupon('MV15', rec)

            expect(res.errorIsNew).toBe(false)
            expect(performance.now() - startedAt).toBeGreaterThan(9000)
        },
        SLOW,
    )

    it('a refused code after a re-drawn one is judged on its own redraws only', async () => {
        // The watch from the second code must not answer for the third.
        const [, second, third] = await refusedCodes(
            n => n === 2 && later(() => (msg().textContent = REFUSAL)),
            ['MV15', 'ASFSP15', 'SMPCSS15'],
        )

        expect(second.res.errorIsNew).toBe(true)
        expect(third.res.errorIsNew).toBe(false)
        expect(third.ms).toBeGreaterThan(9000)
    }, 30000)
})
