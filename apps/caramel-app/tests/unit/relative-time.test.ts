import { formatWorkedAgo, formatWorkedLabel } from '@/lib/relativeTime'
import { describe, expect, it } from 'vitest'

// Boundary pins for the trust-line formatter: "Just worked" under an hour
// (never "worked 0h ago" — the wording that read as a glitch on /coupons),
// "Worked Xh ago" under a day, "Worked Xd ago" up to the 7-day ceiling.
// Every case passes an explicit `now`, so the pins are exact at the boundaries
// with no fake timers and no race against the real clock.
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ago(ms: number): string {
    return new Date(NOW - ms).toISOString()
}

describe('formatWorkedAgo', () => {
    it('null / undefined → null', () => {
        expect(formatWorkedAgo(null, NOW)).toBeNull()
        expect(formatWorkedAgo(undefined, NOW)).toBeNull()
    })

    it('an unparseable value → null', () => {
        expect(formatWorkedAgo('not-a-date', NOW)).toBeNull()
    })

    it('under an hour → "Just worked" (0s, 1 min, 59 min 59 s)', () => {
        expect(formatWorkedAgo(ago(0), NOW)).toBe('Just worked')
        expect(formatWorkedAgo(ago(MINUTE), NOW)).toBe('Just worked')
        expect(formatWorkedAgo(ago(HOUR - 1000), NOW)).toBe('Just worked')
    })

    it('exactly 1h ago → "Worked 1h ago" (the first whole hour)', () => {
        expect(formatWorkedAgo(ago(HOUR), NOW)).toBe('Worked 1h ago')
    })

    it('23h 59m ago → "Worked 23h ago" (still whole hours under a day)', () => {
        expect(formatWorkedAgo(ago(DAY - MINUTE), NOW)).toBe('Worked 23h ago')
    })

    it('exactly 24h ago → "Worked 1d ago" (crosses into whole days)', () => {
        expect(formatWorkedAgo(ago(DAY), NOW)).toBe('Worked 1d ago')
    })

    it('6d ago → "Worked 6d ago"; exactly 7d is the last day shown', () => {
        expect(formatWorkedAgo(ago(6 * DAY), NOW)).toBe('Worked 6d ago')
        expect(formatWorkedAgo(ago(7 * DAY), NOW)).toBe('Worked 7d ago')
    })

    it('older than 7 days → null (stale trust is no trust)', () => {
        expect(formatWorkedAgo(ago(7 * DAY + 1), NOW)).toBeNull()
    })

    it('a few minutes in the future (server clock ahead of this one) → "Just worked", not hidden', () => {
        expect(formatWorkedAgo(ago(-4 * MINUTE), NOW)).toBe('Just worked')
    })

    it('far in the future (beyond the 5-min skew tolerance) → null (bogus signal)', () => {
        expect(formatWorkedAgo(ago(-HOUR), NOW)).toBeNull()
    })

    it('accepts a Date as well as an ISO string', () => {
        expect(formatWorkedAgo(new Date(NOW - 3 * HOUR), NOW)).toBe(
            'Worked 3h ago',
        )
    })
})

describe('formatWorkedLabel (landing strip: never ages out)', () => {
    it('uses the relative label while there is one', () => {
        expect(formatWorkedLabel(ago(3 * HOUR), NOW)).toBe('Worked 3h ago')
        expect(formatWorkedLabel(ago(7 * DAY), NOW)).toBe('Worked 7d ago')
    })

    it('falls back to the UTC date once the relative label stops', () => {
        expect(formatWorkedLabel('2026-09-12T23:30:00.000Z', NOW)).toBe(
            'Worked Sep 12',
        )
    })

    it('stays null for absent, unparseable or future timestamps', () => {
        expect(formatWorkedLabel(null, NOW)).toBeNull()
        expect(formatWorkedLabel('not-a-date', NOW)).toBeNull()
        expect(formatWorkedLabel(ago(-HOUR), NOW)).toBeNull()
    })
})
