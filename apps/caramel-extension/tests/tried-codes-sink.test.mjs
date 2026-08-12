import { beforeEach, describe, expect, it } from 'vitest'
import { caramelSinkTriedCodes } from '../coupon-apply.js'

// The manual list exists to answer "what can I try myself?" — and it was
// answering with the codes the shopper had just watched fail.
//
// allbirds.com: the progress bar counted through AFF-1023, FASTSHIP1023 and
// FLUFF, and the result modal then offered those three at the top.
// proaudiostar.com, where every attempt costs a full page reload: the first
// entry was LB15, which the store had rejected BY NAME thirty seconds earlier.
// A shopper working top-down spends their next reload on a code we already know
// is dead.
//
// Only the order changes. Nothing is hidden — a code the store refused from our
// synthetic input can still work pasted by hand — and nothing is labelled
// "rejected" without the store's own words for it.

beforeEach(() => {
    sessionStorage.clear()
})

const codes = list => list.map(c => c.code)

describe('caramelSinkTriedCodes', () => {
    const LIST = [
        { code: 'LB15' },
        { code: '5MORE' },
        { code: 'CH20' },
        { code: 'PAS18' },
    ]

    it('puts the codes we already spent an attempt on last', () => {
        const sunk = caramelSinkTriedCodes(LIST, { LB15: Date.now() })

        expect(codes(sunk)).toEqual(['5MORE', 'CH20', 'PAS18', 'LB15'])
    })

    it('keeps the untried codes in the order they came', () => {
        const sunk = caramelSinkTriedCodes(LIST, {
            LB15: Date.now(),
            CH20: Date.now(),
        })

        expect(codes(sunk)).toEqual(['5MORE', 'PAS18', 'LB15', 'CH20'])
    })

    it('hides nothing — every code is still offered', () => {
        const sunk = caramelSinkTriedCodes(LIST, {
            LB15: Date.now(),
            '5MORE': Date.now(),
            CH20: Date.now(),
            PAS18: Date.now(),
        })

        expect(codes(sunk).sort()).toEqual(codes(LIST).sort())
    })

    it('leaves a list alone when nothing has been tried', () => {
        expect(codes(caramelSinkTriedCodes(LIST, {}))).toEqual(codes(LIST))
    })

    it('reads the session tried-set when none is passed', () => {
        // This is how the post-navigation modal knows: the codes were marked
        // on a document that no longer exists.
        sessionStorage.setItem(
            'caramel_tried_codes',
            JSON.stringify({ LB15: Date.now() }),
        )

        expect(codes(caramelSinkTriedCodes(LIST))).toEqual([
            '5MORE',
            'CH20',
            'PAS18',
            'LB15',
        ])
    })

    it('survives a missing or ragged list', () => {
        expect(caramelSinkTriedCodes(null)).toEqual([])
        expect(caramelSinkTriedCodes(undefined, {})).toEqual([])
    })
})
