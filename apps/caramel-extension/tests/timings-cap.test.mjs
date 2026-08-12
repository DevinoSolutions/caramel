import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase, recordTiming } from '../caramel-base.js'

// Pins the caramel-base.js recordTiming write cap: the apply-flow debug
// telemetry (coupon-apply.js / coupon-fetch.js call sites) has no in-extension
// reader, so the only thing protecting storage from unbounded growth is the
// write-time trim to the newest CARAMEL_TIMINGS_MAX (50) entries — same policy
// as the savings-history cap in settings-savings.test.mjs. Storage is faked
// with a real in-memory map (the permissive stub's default empty storage isn't
// enough here — these tests assert the persisted shape).
let localData

// initCaramelBase() resolves `currentBrowser` from the `chrome` global and
// publishes it as window.currentBrowser — so the storage seam below is the same
// one the old harness offered, and it is installed ONCE: the bootstrap's
// double-load guard makes a second call keep the FIRST browser object, exactly
// as a re-injected content script would. Per-test freshness comes from
// re-pointing `localData`, which these closures read at call time.
beforeAll(() => {
    globalThis.chrome = {
        storage: {
            local: {
                get: (_keys, cb) => cb({ ...localData }),
                set: (items, cb) => {
                    Object.assign(localData, items)
                    if (cb) cb()
                },
            },
        },
    }
    initCaramelBase()
})

beforeEach(() => {
    localData = {}
})

describe('caramel-base.js timings telemetry', () => {
    it('appends entries with the {event, t, meta} shape', () => {
        recordTiming('AUTO_INSERT_ATTEMPT_START', { code: 'SAVE10' })
        expect(localData.caramel_timings).toHaveLength(1)
        expect(localData.caramel_timings[0]).toMatchObject({
            event: 'AUTO_INSERT_ATTEMPT_START',
            meta: { code: 'SAVE10' },
        })
        expect(typeof localData.caramel_timings[0].t).toBe('number')
    })

    it('caps the log at 50 entries, keeping the newest', () => {
        for (let i = 0; i < 55; i++) {
            recordTiming(`EVENT_${i}`)
        }
        expect(localData.caramel_timings).toHaveLength(50)
        expect(localData.caramel_timings[0].event).toBe('EVENT_5') // oldest kept
        expect(localData.caramel_timings[49].event).toBe('EVENT_54') // newest kept
    })
})
