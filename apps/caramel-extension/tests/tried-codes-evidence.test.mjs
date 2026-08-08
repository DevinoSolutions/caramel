import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// Codes are marked "tried" at attempt START so a full-page-POST apply that
// destroys the content script mid-flow doesn't make the next run re-grind the
// same codes from #1. That is right. What was wrong is that the mark STAYED
// even when the attempt proved nothing at all — and coupon-runner.js filters
// tried codes out of the manual copy list as well as the auto-apply queue, so
// the user loses the code in both directions for the rest of the tab session.
//
// Two independent live cases on 2026-08-05, both money:
//   toms.com  — TOMS15 won a verified -$11.25 earlier the same day. On a later
//               run the cart probe fell back to the DOM form, both attempts
//               read newTotal NaN, the user was told "didn't stick" with
//               TOMS15 offered as the code to paste BY HAND, and the re-run
//               logged SKIP_TRIED and could never reach it again.
//   bombas.com— NATE, badged "Verified" in our own popup and worth a real
//               -$11.10, disappeared from both the queue and the copy list,
//               leaving 16 unevidenced codes in its place.
//
// The same mechanism burns codes attempted against an EMPTY cart, where no
// total can move by definition.

let _getTriedCodes
let _markTriedCode
let _unmarkTriedCode

beforeAll(() => {
    ;({ _getTriedCodes, _markTriedCode, _unmarkTriedCode } =
        loadExtensionSources(
            ['caramel-base.js', 'dom-utils.js', 'coupon-apply.js'],
            ['_getTriedCodes', '_markTriedCode', '_unmarkTriedCode'],
        ))
})

beforeEach(() => {
    sessionStorage.clear()
})

/** The runner's rule for "this attempt proved nothing about the code". */
const provedNothing = res =>
    !res.committed &&
    !(res.errorMsg && res.errorIsNew) &&
    !Number.isFinite(res.newTotal)

describe('tried-code memory only remembers attempts that proved something', () => {
    it('still remembers a code the store actually rejected', () => {
        // The whole point of the memory: a genuine rejection must not be
        // re-ground on the next run.
        _markTriedCode('DEADCODE')
        const res = {
            committed: false,
            errorMsg: 'That code is not valid.',
            errorIsNew: true,
        }
        expect(provedNothing(res)).toBe(false)
        expect('DEADCODE' in _getTriedCodes()).toBe(true)
    })

    it('releases a code whose only "error" was the page’s own furniture', () => {
        // mango.com/ae: the quote was the promo field's LABEL. Believing it
        // costs the shopper the code in the copy list too — the same loss the
        // toms/bombas cases proved, arriving through a different door.
        _markTriedCode('PROMO10')
        const res = {
            committed: false,
            errorMsg: 'رمز ترويجي',
            errorIsNew: false,
            newTotal: NaN,
        }
        expect(provedNothing(res)).toBe(true)
        _unmarkTriedCode('PROMO10')
        expect('PROMO10' in _getTriedCodes()).toBe(false)
    })

    it('still remembers a code that committed a row', () => {
        _markTriedCode('ROWCODE')
        expect(provedNothing({ committed: true, errorMsg: null })).toBe(false)
        expect('ROWCODE' in _getTriedCodes()).toBe(true)
    })

    it('still remembers a code measured against a readable total', () => {
        _markTriedCode('MEASURED')
        const res = { committed: false, errorMsg: null, newTotal: 7500 }
        expect(provedNothing(res)).toBe(false)
        expect('MEASURED' in _getTriedCodes()).toBe(true)
    })

    it('releases a code whose total could not be read at all (the toms/bombas case)', () => {
        _markTriedCode('TOMS15')
        const res = { committed: false, errorMsg: null, newTotal: NaN }
        expect(provedNothing(res)).toBe(true)
        _unmarkTriedCode('TOMS15')
        expect('TOMS15' in _getTriedCodes()).toBe(false)
    })

    it('releases a code when the result carried no total field at all', () => {
        // applyCoupon's early-return branches (missing input, refused control)
        // omit newTotal entirely — those attempts tested nothing either.
        _markTriedCode('NATE')
        expect(provedNothing({ committed: false, errorMsg: null })).toBe(true)
        _unmarkTriedCode('NATE')
        expect('NATE' in _getTriedCodes()).toBe(false)
    })

    it('leaves other codes alone when releasing one', () => {
        _markTriedCode('KEEPME')
        _markTriedCode('DROPME')
        _unmarkTriedCode('DROPME')
        const tried = _getTriedCodes()
        expect('KEEPME' in tried).toBe(true)
        expect('DROPME' in tried).toBe(false)
    })

    it('is a no-op for a code that was never marked', () => {
        _markTriedCode('KEEPME')
        _unmarkTriedCode('NEVER_MARKED')
        expect(Object.keys(_getTriedCodes())).toEqual(['KEEPME'])
    })

    it('survives a released code being re-marked on a later attempt', () => {
        // Releasing must not poison the key — the next real attempt has to be
        // able to record its verdict normally.
        _markTriedCode('RETRY')
        _unmarkTriedCode('RETRY')
        _markTriedCode('RETRY')
        expect('RETRY' in _getTriedCodes()).toBe(true)
    })
})
