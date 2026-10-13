import {
    admitFailedReport,
    releaseFailedReport,
    resetFailedReportDedupeForTests,
} from '@/lib/couponFailureReportDedupe'
import * as Sentry from '@sentry/nextjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-reporter 'failed' dedupe is an in-memory Map with a hard key cap:
// past the cap it FAILS OPEN (accept, untracked) and warns Sentry at most once
// an hour. These pins cover the window, the cap, the sweep and the report
// throttle with an injected clock and a tiny cap.
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-11T12:00:00.000Z')
const ip = (n: number) => ({ kind: 'ip', ip: `203.0.113.${n}` }) as const
const user = (id: string) => ({ kind: 'user', userId: id }) as const

beforeEach(() => {
    resetFailedReportDedupeForTests()
    vi.mocked(Sentry.captureMessage).mockClear()
})

describe('failed-report dedupe window', () => {
    it('admits the first report, rejects a repeat inside 24h, admits again after the window', () => {
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(1), '7', T0 + DAY - 1)).toBe(false)
        expect(admitFailedReport(ip(1), '7', T0 + DAY)).toBe(true)
    })

    it('is per (reporter, coupon): another reporter or another coupon is admitted', () => {
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(2), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(1), '8', T0)).toBe(true)
    })

    it('a user and an IP never share a slot, even with the same text', () => {
        expect(admitFailedReport(user('203.0.113.1'), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        expect(admitFailedReport(user('203.0.113.1'), '7', T0)).toBe(false)
    })

    it('release frees the slot for a retry', () => {
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        releaseFailedReport(ip(1), '7')
        expect(admitFailedReport(ip(1), '7', T0 + 1)).toBe(true)
    })
})

describe('failed-report dedupe key cap (fail open)', () => {
    it('at the cap a NEW reporter is admitted untracked, so its repeat is admitted too', () => {
        resetFailedReportDedupeForTests({ maxKeys: 2 })
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(2), '7', T0)).toBe(true)

        // Table full: fail open, and nothing was tracked for ip(3).
        expect(admitFailedReport(ip(3), '7', T0)).toBe(true)
        expect(admitFailedReport(ip(3), '7', T0)).toBe(true)
        // The two tracked reporters are still deduped: the cap never refuses a
        // report, it only stops tracking new ones.
        expect(admitFailedReport(ip(1), '7', T0)).toBe(false)
        expect(admitFailedReport(ip(2), '7', T0)).toBe(false)
    })

    it('never refuses an honest report because the table is full', () => {
        resetFailedReportDedupeForTests({ maxKeys: 1 })
        expect(admitFailedReport(ip(1), '7', T0)).toBe(true)
        for (let n = 2; n < 50; n++) {
            expect(admitFailedReport(ip(n), '7', T0)).toBe(true)
        }
    })

    it('a full table is swept for expired keys (at most once a minute), freeing room to track again', () => {
        resetFailedReportDedupeForTests({ maxKeys: 2 })
        admitFailedReport(ip(1), '7', T0)
        admitFailedReport(ip(2), '7', T0)

        // A day later both are expired; the sweep makes room, so ip(3) is
        // TRACKED this time (its repeat is rejected).
        const later = T0 + DAY + 1
        expect(admitFailedReport(ip(3), '7', later)).toBe(true)
        expect(admitFailedReport(ip(3), '7', later)).toBe(false)
    })

    it('does not re-sweep a full table more than once a minute', () => {
        resetFailedReportDedupeForTests({ maxKeys: 1 })
        admitFailedReport(ip(1), '7', T0)

        // Full, nothing expired yet: the sweep runs, finds nothing, fails open.
        const sweptAt = T0 + DAY - 10 * 1000
        expect(admitFailedReport(ip(2), '7', sweptAt)).toBe(true)

        // ip(1) has now expired, but the last sweep was only 11s ago: no
        // re-sweep, the table still reads full, ip(3) is untracked.
        const tooSoon = T0 + DAY + 1
        expect(admitFailedReport(ip(3), '7', tooSoon)).toBe(true)
        expect(admitFailedReport(ip(3), '7', tooSoon)).toBe(true)

        // A minute after the last sweep the expired key is reclaimed and the
        // next new reporter is tracked again.
        const swept = sweptAt + 60 * 1000
        expect(admitFailedReport(ip(4), '7', swept)).toBe(true)
        expect(admitFailedReport(ip(4), '7', swept)).toBe(false)
    })

    it('an expired entry for the SAME key is overwritten in place even when the table is full', () => {
        resetFailedReportDedupeForTests({ maxKeys: 1 })
        admitFailedReport(ip(1), '7', T0)
        const later = T0 + DAY + 1
        expect(admitFailedReport(ip(1), '7', later)).toBe(true)
        expect(admitFailedReport(ip(1), '7', later)).toBe(false)
    })

    it('reports the cap to Sentry once per hour, not once per request', () => {
        resetFailedReportDedupeForTests({ maxKeys: 1 })
        admitFailedReport(ip(1), '7', T0)

        for (let n = 2; n < 10; n++) admitFailedReport(ip(n), '7', T0 + n)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(
            vi.mocked(Sentry.captureMessage).mock.calls[0]![1],
        ).toMatchObject({ level: 'warning' })

        admitFailedReport(ip(20), '7', T0 + HOUR - 1)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        admitFailedReport(ip(21), '7', T0 + HOUR + 100)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
    })

    it('stays silent while under the cap', () => {
        resetFailedReportDedupeForTests({ maxKeys: 5 })
        for (let n = 1; n <= 5; n++) admitFailedReport(ip(n), '7', T0)
        expect(Sentry.captureMessage).not.toHaveBeenCalled()
    })
})
