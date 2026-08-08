// Two independent witnesses, and what happens when they disagree.
//
// The console trail and chrome.storage.local.caramel_timings are separate
// records of the same run: the console is written by log() in the page, the
// timings by recordTiming() into extension storage (readable only through the
// service-worker handle — page evaluate runs in the store's world and cannot
// see it at all). The probe reports BOTH and picks no winner, because the
// disagreement is usually the interesting bug: a log emitted on a path that
// never reached storage, or storage evicting evidence the console still holds.
import { describe, expect, it } from 'vitest'
import {
    COMPARABLE_EVENTS,
    diffWitnesses,
    TIMINGS_CAP,
} from '../../../tools/ext-probe/verdict.mjs'

const line = (event, rest = '') => `[log] Caramel: ${event} ${rest}`.trim()

describe('the comparable-event set', () => {
    it('is exactly the recordTiming call sites, not the whole console vocabulary', () => {
        // The console emits far more AUTO_INSERT_* lines than recordTiming ever
        // writes, so comparing the full sets would manufacture a disagreement
        // on every single run.
        expect([...COMPARABLE_EVENTS].sort()).toEqual([
            'AUTO_INSERT_ATTEMPT_END',
            'AUTO_INSERT_ATTEMPT_START',
            'AUTO_INSERT_FETCHCOUPONS_END',
            'AUTO_INSERT_FETCHCOUPONS_START',
            'STORE_LIST_FETCH_FAILED',
        ])
    })

    it('knows the storage cap recordTiming applies at write time', () => {
        expect(TIMINGS_CAP).toBe(50)
    })
})

describe('agreeing witnesses', () => {
    const consoleTrail = [
        '[log] Caramel: Loaded supported domains from API',
        line('CHECKOUT_VIA_CART_PAYLOAD', '{"items":1}'),
        line('AUTO_INSERT_FETCHCOUPONS_START'),
        line('AUTO_INSERT_FETCHCOUPONS_END', '{"count":7}'),
        line('AUTO_INSERT_ATTEMPT_START', 'SAVE10'),
        line('AUTO_INSERT_ATTEMPT_END', 'SAVE10 {"success":true}'),
    ]
    const timings = [
        { event: 'AUTO_INSERT_FETCHCOUPONS_START', t: 1, meta: {} },
        { event: 'AUTO_INSERT_FETCHCOUPONS_END', t: 2, meta: { count: 7 } },
        { event: 'AUTO_INSERT_ATTEMPT_START', t: 3, meta: { code: 'SAVE10' } },
        {
            event: 'AUTO_INSERT_ATTEMPT_END',
            t: 4,
            meta: { code: 'SAVE10', success: true },
        },
    ]

    it('reports no disagreement', () => {
        const d = diffWitnesses(consoleTrail, timings)
        expect(d.detected).toBe(false)
        expect(d.details).toEqual([])
    })

    it('ignores the console-only vocabulary (CHECKOUT_VIA_*) rather than counting it against storage', () => {
        const d = diffWitnesses(consoleTrail, timings)
        expect(d.consoleCounts.CHECKOUT_VIA_CART_PAYLOAD).toBe(1)
        expect(d.details.map(x => x.event)).not.toContain(
            'CHECKOUT_VIA_CART_PAYLOAD',
        )
    })

    it('counts an event once per line however often the name is echoed in its own payload', () => {
        const d = diffWitnesses(
            [
                line(
                    'AUTO_INSERT_ATTEMPT_END',
                    '{"prev":"AUTO_INSERT_ATTEMPT_END"}',
                ),
            ],
            [{ event: 'AUTO_INSERT_ATTEMPT_END', t: 1, meta: {} }],
        )
        expect(d.detected).toBe(false)
    })
})

describe('disagreeing witnesses are reported, never resolved', () => {
    it('flags an event the console saw and storage did not', () => {
        const d = diffWitnesses(
            [
                line('AUTO_INSERT_FETCHCOUPONS_START'),
                line('AUTO_INSERT_FETCHCOUPONS_END', '{"count":3}'),
            ],
            [{ event: 'AUTO_INSERT_FETCHCOUPONS_START', t: 1, meta: {} }],
        )
        expect(d.detected).toBe(true)
        expect(d.details).toContainEqual({
            event: 'AUTO_INSERT_FETCHCOUPONS_END',
            console: 1,
            timings: 0,
        })
        // Both counts survive into the report. Nothing picks a winner.
        expect(d.consoleCounts.AUTO_INSERT_FETCHCOUPONS_END).toBe(1)
        expect(d.timingCounts.AUTO_INSERT_FETCHCOUPONS_END).toBeUndefined()
    })

    it('flags an event storage holds and the console never printed', () => {
        const d = diffWitnesses(
            [],
            [{ event: 'STORE_LIST_FETCH_FAILED', t: 1, meta: {} }],
        )
        expect(d.detected).toBe(true)
        expect(d.details).toContainEqual({
            event: 'STORE_LIST_FETCH_FAILED',
            console: 0,
            timings: 1,
        })
    })

    it('marks the storage cap as an EXPLANATION, not a dismissal', () => {
        // At 50 entries recordTiming has been dropping the oldest, so a
        // difference is explainable — which is not the same as forgiven.
        const timings = Array.from({ length: TIMINGS_CAP }, (_, i) => ({
            event: 'AUTO_INSERT_ATTEMPT_END',
            t: i,
            meta: {},
        }))
        const d = diffWitnesses(
            [line('AUTO_INSERT_FETCHCOUPONS_START')],
            timings,
        )
        expect(d.timingsAtCap).toBe(true)
        expect(d.detected).toBe(true)
    })

    it('does not claim the cap when storage is below it', () => {
        const d = diffWitnesses(
            [],
            [{ event: 'AUTO_INSERT_ATTEMPT_END', t: 1, meta: {} }],
        )
        expect(d.timingsAtCap).toBe(false)
    })

    it('tolerates a missing witness without inventing agreement', () => {
        const d = diffWitnesses(null, null)
        expect(d.detected).toBe(false)
        expect(d.consoleCounts).toEqual({})
        expect(d.timingCounts).toEqual({})
    })
})
