import {
    admitReport,
    releaseReport,
    reporterFor,
    reporterNetwork,
    resetReportDedupeForTests,
} from '@/lib/couponReportDedupe'
import * as Sentry from '@sentry/nextjs'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-reporter report dedupe is an in-memory Map with a hard key cap: past
// the cap it sweeps expired keys, then EVICTS the oldest key (the dedupe never
// switches off) and warns Sentry at most once an hour. These pins cover the
// window, the cap, the sweep, the eviction and the report throttle with an
// injected clock and a tiny cap.
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-11T12:00:00.000Z')
const ip = (n: number) => ({ kind: 'ip', ip: `203.0.113.${n}` }) as const
const user = (id: string) =>
    ({ kind: 'user', userId: id, established: false }) as const

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
            established: false,
        })
        expect(reporterFor('user-1', req, true)).toEqual({
            kind: 'user',
            userId: 'user-1',
            established: true,
        })
        expect(reporterFor(null, req)).toEqual({
            kind: 'ip',
            ip: '203.0.113.9',
        })
    })

    it('a signed-out shopper on IPv6 is one reporter for the whole /64, whatever address they report from', () => {
        const from = (addr: string) =>
            reporterFor(
                null,
                new NextRequest('http://localhost/api/coupons/7/report', {
                    headers: { 'cf-connecting-ip': addr },
                }),
            )
        const a = from('2001:db8:1:2:aaaa::1')
        const b = from('2001:db8:1:2:bbbb:cccc:dddd:eeee')
        expect(a).toEqual({ kind: 'ip', ip: '2001:db8:1:2::/64' })
        expect(b).toEqual(a)
        expect(admitReport('worked', a, '7', T0)).toBe(true)
        expect(admitReport('worked', b, '7', T0)).toBe(false)
        // Another home's /64 is another reporter.
        const other = from('2001:db8:1:3::1')
        expect(admitReport('worked', other, '7', T0)).toBe(true)
    })

    it.each([
        ['203.0.113.9', '203.0.113.9'],
        ['2001:DB8:0001:0002::1', '2001:db8:1:2::/64'],
        ['2001:db8::1', '2001:db8:0:0::/64'],
        ['::1', '0:0:0:0::/64'],
        ['fe80::1%eth0', 'fe80:0:0:0::/64'],
        ['::ffff:203.0.113.9', '203.0.113.9'],
        ['64:ff9b::203.0.113.9', '64:ff9b:0:0::/64'],
        ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
        // Not an address: kept whole, never merged with anything else.
        ['unknown', 'unknown'],
        ['1::2::3', '1::2::3'],
        ['1:2:3', '1:2:3'],
        ['zz:1:2:3::1', 'zz:1:2:3::1'],
    ])('reporterNetwork(%s) is %s', (ip, want) => {
        expect(reporterNetwork(ip)).toBe(want)
    })
})

describe('failed-report dedupe key cap (evict oldest, never off)', () => {
    it('at the cap a NEW reporter is TRACKED (its repeat is deduped) and the oldest key is evicted', () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        expect(admitReport('failed', ip(1), '7', T0)).toBe(true)
        expect(admitReport('failed', ip(2), '7', T0 + 1)).toBe(true)

        // Table full: ip(3) is admitted AND tracked, so its repeat is refused.
        expect(admitReport('failed', ip(3), '7', T0 + 2)).toBe(true)
        expect(admitReport('failed', ip(3), '7', T0 + 3)).toBe(false)
        // ip(1), the oldest, was evicted to make room: it counts once more.
        // ip(2) is still tracked.
        expect(admitReport('failed', ip(2), '7', T0 + 4)).toBe(false)
        expect(admitReport('failed', ip(1), '7', T0 + 5)).toBe(true)
    })

    it('a flood past the cap never switches the dedupe off: the most recent reporters stay deduped', () => {
        resetReportDedupeForTests({ maxKeys: 3 })
        for (let n = 1; n <= 50; n++) {
            expect(admitReport('failed', ip(n), '7', T0 + n)).toBe(true)
        }
        // Every one of the last three is tracked.
        for (let n = 48; n <= 50; n++) {
            expect(admitReport('failed', ip(n), '7', T0 + 100)).toBe(false)
        }
    })

    it('a full table is swept for expired keys (at most once a minute) before anything is evicted', () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        admitReport('failed', ip(1), '7', T0)
        admitReport('failed', ip(2), '7', T0 + 1)

        // A day later both are expired; the sweep makes room, so ip(3) is
        // tracked without evicting a live key and no cap warning fires.
        const later = T0 + DAY + 2
        expect(admitReport('failed', ip(3), '7', later)).toBe(true)
        expect(admitReport('failed', ip(3), '7', later)).toBe(false)
        expect(Sentry.captureMessage).not.toHaveBeenCalled()
    })

    it('does not re-sweep a full table more than once a minute, but still tracks each newcomer by evicting', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), '7', T0)

        // Full, nothing expired yet: the sweep runs, finds nothing, ip(1) is
        // evicted so ip(2) is tracked.
        const sweptAt = T0 + DAY - 10 * 1000
        expect(admitReport('failed', ip(2), '7', sweptAt)).toBe(true)
        expect(admitReport('failed', ip(2), '7', sweptAt + 1)).toBe(false)

        // ip(2) has not expired and the last sweep was seconds ago: ip(3)
        // evicts it and is tracked in its place.
        const soon = sweptAt + 2
        expect(admitReport('failed', ip(3), '7', soon)).toBe(true)
        expect(admitReport('failed', ip(3), '7', soon + 1)).toBe(false)
    })

    it('an expired entry for the SAME key is re-taken in place even when the table is full, evicting nothing', () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        admitReport('failed', ip(1), '7', T0)
        admitReport('failed', ip(2), '7', T0 + 5)
        const later = T0 + DAY + 1
        // ip(1) expired exactly; ip(2) is still live (expires T0 + 5 + DAY).
        expect(admitReport('failed', ip(1), '7', later)).toBe(true)
        expect(admitReport('failed', ip(1), '7', later)).toBe(false)
        expect(admitReport('failed', ip(2), '7', later)).toBe(false)
    })

    it('reports the cap to Sentry once per hour, not once per request, naming the eviction', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), '7', T0)

        for (let n = 2; n < 10; n++) admitReport('failed', ip(n), '7', T0 + n)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(vi.mocked(Sentry.captureMessage).mock.calls[0]![0]).toContain(
            'evicting oldest',
        )
        expect(
            vi.mocked(Sentry.captureMessage).mock.calls[0]![1],
        ).toMatchObject({ level: 'warning' })

        admitReport('failed', ip(20), '7', T0 + HOUR - 1)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        admitReport('failed', ip(21), '7', T0 + HOUR + 100)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
    })

    it('the cap warning carries route context and no reporter or coupon identity', () => {
        resetReportDedupeForTests({ maxKeys: 1 })
        admitReport('failed', ip(1), 'coupon-secret-7', T0)
        admitReport('failed', ip(2), 'coupon-secret-7', T0 + 1)

        const payload = JSON.stringify(
            vi.mocked(Sentry.captureMessage).mock.calls,
        )
        expect(payload).toContain('coupons/report')
        expect(payload).not.toContain('203.0.113')
        expect(payload).not.toContain('coupon-secret-7')
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
