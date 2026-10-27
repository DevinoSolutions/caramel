import { beforeEach, describe, expect, it, vi } from 'vitest'

// A take the background did not answer is not "nothing pending". Before this,
// a 3s stall (a waking worker) read as an empty record: the page cleared its
// hint, so the next document never asked again, and a real saving from a
// form-POST submit showed no result card.
let answers
const calls = []
vi.mock('../caramel-base.js', async importOriginal => ({
    ...(await importOriginal()),
    caramelTabHandoff: async (op, key) => {
        calls.push(`${op} ${key}`)
        return answers.length ? answers.shift() : null
    },
}))
const {
    caramelHandoffMayExist,
    caramelTakePendingSubmit,
    caramelTakeAppliedWin,
    caramelClaimRunHop,
} = await import('../dom-utils.js')

const HINT = 'caramel_handoff_hint'
const record = code => ({ value: { code, id: 7, prices: [50], t: Date.now() } })

beforeEach(() => {
    calls.length = 0
    answers = []
    sessionStorage.setItem(
        HINT,
        JSON.stringify(['pending_submit', 'applied', 'run']),
    )
})

describe('a take the background did not answer', () => {
    it('is asked once more, and the record the retry gets is returned', async () => {
        answers = [null, record('THEO20')]
        const st = await caramelTakePendingSubmit()
        expect(st?.code).toBe('THEO20')
        expect(calls).toEqual(['take pending_submit', 'take pending_submit'])
        expect(caramelHandoffMayExist('pending_submit')).toBe(false)
    })

    it('keeps the hint when both asks go unanswered, so the next document asks again', async () => {
        answers = [null, null]
        expect(await caramelTakePendingSubmit()).toBeNull()
        expect(caramelHandoffMayExist('pending_submit')).toBe(true)
    })

    it('clears the hint when the background answered that nothing is pending', async () => {
        answers = [{ value: null }]
        expect(await caramelTakePendingSubmit()).toBeNull()
        expect(calls).toEqual(['take pending_submit'])
        expect(caramelHandoffMayExist('pending_submit')).toBe(false)
    })

    it('does not ask at all when the hint says nothing was left', async () => {
        sessionStorage.setItem(HINT, JSON.stringify(['applied']))
        expect(await caramelTakePendingSubmit()).toBeNull()
        expect(calls).toEqual([])
    })

    it('holds for an applied discount-link win too', async () => {
        answers = [
            null,
            { value: { code: 'SAVE10', saved: 12.5, t: Date.now() } },
        ]
        const win = await caramelTakeAppliedWin()
        expect(win).toMatchObject({ code: 'SAVE10', saved: 12.5 })
        expect(caramelHandoffMayExist('applied')).toBe(false)
    })
})

// The next page of a run reads the run record before it claims a hop. An
// unanswered read used to look like no run at all, and the run stopped after
// one code (4inkjets.com, T-9245).
describe('a run read the background did not answer', () => {
    const run = { hops: 1, t: Date.now() }

    it('is asked once more, and the hop is claimed from the retry', async () => {
        answers = [null, { value: run }, { saved: 'saved' }]
        expect(await caramelClaimRunHop()).toEqual({ hops: 2, remaining: 4 })
        expect(calls).toEqual(['get run', 'get run', 'replace run'])
    })

    it('claims nothing when both asks go unanswered', async () => {
        answers = [null, null]
        expect(await caramelClaimRunHop()).toBeNull()
        expect(calls).toEqual(['get run', 'get run'])
    })

    it('does not ask twice when the background answered there is no run', async () => {
        answers = [{ value: null }]
        expect(await caramelClaimRunHop()).toBeNull()
        expect(calls).toEqual(['get run'])
    })
})
