import { beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSource } from './_load.mjs'

// Pins the caramel-base.js recordTiming write cap: the apply-flow debug
// telemetry (coupon-apply.js / coupon-fetch.js call sites) has no in-extension
// reader, so the only thing protecting storage from unbounded growth is the
// write-time trim to the newest CARAMEL_TIMINGS_MAX (50) entries — same policy
// as the savings-history cap in settings-savings.test.mjs. Storage is faked
// with a real in-memory map (the permissive stub's default empty storage isn't
// enough here — these tests assert the persisted shape).
let helpers
let localData

beforeEach(() => {
    helpers = loadExtensionSource('caramel-base.js', ['recordTiming'])
    localData = {}
    globalThis.currentBrowser.storage.local.get = (_keys, cb) =>
        cb({ ...localData })
    globalThis.currentBrowser.storage.local.set = (items, cb) => {
        Object.assign(localData, items)
        if (cb) cb()
    }
})

describe('caramel-base.js timings telemetry', () => {
    it('appends entries with the {event, t, meta} shape', () => {
        helpers.recordTiming('AUTO_INSERT_ATTEMPT_START', { code: 'SAVE10' })
        expect(localData.caramel_timings).toHaveLength(1)
        expect(localData.caramel_timings[0]).toMatchObject({
            event: 'AUTO_INSERT_ATTEMPT_START',
            meta: { code: 'SAVE10' },
        })
        expect(typeof localData.caramel_timings[0].t).toBe('number')
    })

    it('caps the log at 50 entries, keeping the newest', () => {
        for (let i = 0; i < 55; i++) {
            helpers.recordTiming(`EVENT_${i}`)
        }
        expect(localData.caramel_timings).toHaveLength(50)
        expect(localData.caramel_timings[0].event).toBe('EVENT_5') // oldest kept
        expect(localData.caramel_timings[49].event).toBe('EVENT_54') // newest kept
    })
})
