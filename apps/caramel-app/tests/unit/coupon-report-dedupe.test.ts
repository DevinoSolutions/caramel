import {
    admitReport,
    releaseReport,
    reporterFor,
    resetReportDedupeForTests,
} from '@/lib/couponReportDedupe'
import * as Sentry from '@sentry/nextjs'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-reporter report dedupe is an in-memory Map with a hard key cap:
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
    resetReportDedupeForTests()
    vi.mocked(Sentry.captureMessage).mockClear()
})

describe('failed-report dedupe window', () => {
    it('admits the first report, rejects a repeat inside 24h, admits again after the window', () => {
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(1), '7', T0 + DAY - 1)).toBe(false)
        expect(admitReport('failed', ip(1), '7', T0 + DAY)).toBe(true)
    })

    it('is per (reporter, coupon): another reporter or another coupon is admitted', () => {
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(2), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(1), '8', T0)).toBe(true)
    })

    it('a user and an IP never share a slot, even with the same text', () => {
        expect(admitReport('failed', user('203.0.113.1'), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', user('203.0.113.1'), '7', T0)).toBe(false)
    })

    it('release frees the slot for a retry', () => {
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        releaseReport('failed', ip(1), '7')
        expect(admitReport('failed', ip(1), '7', T0 + 1)).toBe(true)
    })
})

describe('report kinds', () => {
    it('a repeated worked report, or a repeated use, is deduped inside 24h like a failed one', () => {
        expect(admitReport('worked', ip(1), '7', T0)).toBe(true)
        expect(admitReport('worked', ip(1), '7', T0 + DAY - 1)).toBe(false)
        expect(admitReport('worked', ip(1), '7', T0 + DAY)).toBe(true)
        expect(admitReport('used', user('u1'), '7', T0)).toBe(true)
        expect(admitReport('used', user('u1'), '7', T0 + 1)).toBe(false)
    })

    it('each kind has its own slot: worked, used and failed from one reporter all count once', () => {
        expect(admitReport('worked', ip(1), '7', T0)).toBe(true)
        expect(admitReport('used', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('worked', ip(1), '7', T0)).toBe(false)
        expect(admitReport('used', ip(1), '7', T0)).toBe(false)
        expect(admitReport('failed', ip(1), '7', T0)).toBe(false)
    })

    it('release frees only the slot of its own kind', () => {
        admitReport('worked', ip(1), '7', T0)
        admitReport('failed', ip(1), '7', T0)
        releaseReport('worked', ip(1), '7')
        expect(admitReport('worked', ip(1), '7', T0 + 1)).toBe(true)
        expect(admitReport('failed', ip(1), '7', T0 + 1)).toBe(false)
    })

    it('the reporter is the signed-in user when there is one, else the client IP', () => {
        const req = new NextRequest('http://localhost/api/coupons/7/report', {
            headers: { 'cf-connecting-ip': '203.0.113.9' },
        })
        expect(reporterFor('user-1', req)).toEqual({
            kind: 'user',
            userId: 'user-1',
        })
        expect(reporterFor(null, req)).toEqual({
            kind: 'ip',
            ip: '203.0.113.9',
        })
    })
})

describe('failed-report dedupe key cap (fail open)', () => {
    it('at the cap a NEW reporter is admitted untracked, so its repeat is admitted too', () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(2), '7', T0)).toBe(true)

        // Table full: fail open, and nothing was tracked for ip(3).
        expect(admitReport('failed', ip(3), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(3), '7', T0)).toBe(true)
        // The two tracked reporters are still deduped: the cap never refuses a
        // report, it only stops tracking new ones.
        expect(admitReport('failed', ip(1), '7', T0)).toBe(false)
        expect(admitReport('failed', ip(2), '7', T0)).toBe(false)
    })

    it('never refuses an honest report because the table is full', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        for (let n = 2; n < 50; n++) {
            expect(admitReport('failed', ip(n), '7', T0)).toBe(true)
        }
    })

    it('a full table is swept for expired keys (at most once a minute), freeing room to track again', () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        admitReport('failed', ip(1), '7', T0)
        admitReport('failed', ip(2), '7', T0)

        // A day later both are expired; the sweep makes room, so ip(3) is
        // TRACKED this time (its repeat is rejected).
        const later = T0 + DAY + 1
        expect(admitReport('failed', ip(3), '7', later)).toBe(true)
        expect(admitReport('failed', ip(3), '7', later)).toBe(false)
    })

    it('does not re-sweep a full table more than once a minute', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), '7', T0)

        // Full, nothing expired yet: the sweep runs, finds nothing, fails open.
        const sweptAt = T0 + DAY - 10 * 1000
        expect(admitReport('failed', ip(2), '7', sweptAt)).toBe(true)

        // ip(1) has now expired, but the last sweep was only 11s ago: no
        // re-sweep, the table still reads full, ip(3) is untracked.
        const tooSoon = T0 + DAY + 1
        expect(admitReport('failed', ip(3), '7', tooSoon)).toBe(true)
        expect(admitReport('failed', ip(3), '7', tooSoon)).toBe(true)

        // A minute after the last sweep the expired key is reclaimed and the
        // next new reporter is tracked again.
        const swept = sweptAt + 60 * 1000
        expect(admitReport('failed', ip(4), '7', swept)).toBe(true)
        expect(admitReport('failed', ip(4), '7', swept)).toBe(false)
    })

    it('an expired entry for the SAME key is overwritten in place even when the table is full', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), '7', T0)
        const later = T0 + DAY + 1
        expect(admitReport('failed', ip(1), '7', later)).toBe(true)
        expect(admitReport('failed', ip(1), '7', later)).toBe(false)
    })

    it('reports the cap to Sentry once per hour, not once per request', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), '7', T0)

        for (let n = 2; n < 10; n++) admitReport('failed', ip(n), '7', T0 + n)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(
            vi.mocked(Sentry.captureMessage).mock.calls[0]![1],
        ).toMatchObject({ level: 'warning' })

        admitReport('failed', ip(20), '7', T0 + HOUR - 1)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        admitReport('failed', ip(21), '7', T0 + HOUR + 100)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
    })

    it('stays silent while under the cap', () => {
        resetReportDedupeForTests({ maxKeys: 5 })
        for (let n = 1; n <= 5; n++) admitReport('failed', ip(n), '7', T0)
        expect(Sentry.captureMessage).not.toHaveBeenCalled()
    })
})

describe('each kind has its own key cap', () => {
    it('a table full of WORKED keys does not switch off the FAILED dedupe', () => {
        resetReportDedupeForTests({ maxKeys: 3 })
        // Honest success traffic fills the worked table to its cap…
        for (let n = 1; n <= 10; n++) admitReport('worked', ip(n), '7', T0)
        // …and the failed table still tracks: a repeat failed report is deduped.
        expect(admitReport('failed', ip(50), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(50), '7', T0 + 1)).toBe(false)
    })

    it('a table full of USE keys does not switch off the FAILED dedupe either', () => {
        resetReportDedupeForTests({ maxKeys: 3 })
        for (let n = 1; n <= 10; n++) admitReport('used', ip(n), '7', T0)
        expect(admitReport('failed', ip(50), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(50), '7', T0 + 1)).toBe(false)
    })

    it('a cap hit names the route that sends that kind', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('used', ip(1), '7', T0)
        admitReport('used', ip(2), '7', T0)
        admitReport('worked', ip(1), '7', T0)
        admitReport('worked', ip(2), '7', T0)

        const tags = vi
            .mocked(Sentry.captureMessage)
            .mock.calls.map(call => (call[1] as { tags: unknown }).tags)
        expect(tags).toEqual([
            {
                route: 'coupons/increment',
                budget: 'report-dedupe',
                reportKind: 'used',
            },
            {
                route: 'coupons/report',
                budget: 'report-dedupe',
                reportKind: 'worked',
            },
        ])
    })
})
