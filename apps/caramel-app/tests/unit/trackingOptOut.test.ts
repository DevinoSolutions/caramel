import { browserSignalsTrackingOptOut } from '@/lib/analytics/trackingOptOut'
import { describe, expect, it } from 'vitest'

describe('browserSignalsTrackingOptOut', () => {
    it('is true when Global Privacy Control is on', () => {
        expect(
            browserSignalsTrackingOptOut({ globalPrivacyControl: true }, {}),
        ).toBe(true)
    })

    it.each(['1', 'yes'])('is true when navigator.doNotTrack is %s', value => {
        expect(browserSignalsTrackingOptOut({ doNotTrack: value }, {})).toBe(
            true,
        )
    })

    it('is true for the legacy window.doNotTrack flag', () => {
        expect(browserSignalsTrackingOptOut({}, { doNotTrack: '1' })).toBe(true)
    })

    it.each([
        [{ globalPrivacyControl: false, doNotTrack: '0' }, {}],
        [{ doNotTrack: 'unspecified' }, { doNotTrack: null }],
        [{}, {}],
    ])('is false when no opt-out signal is sent (%j)', (nav, win) => {
        expect(browserSignalsTrackingOptOut(nav, win)).toBe(false)
    })

    it('is false when there is no navigator or window', () => {
        expect(browserSignalsTrackingOptOut(null, null)).toBe(false)
    })
})
