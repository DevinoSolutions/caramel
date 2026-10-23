import {
    admitCouponReportVelocity,
    releaseCouponReportVelocity,
    resetReportVelocityForTests,
} from '@/lib/couponReportVelocity'
import * as Sentry from '@sentry/nextjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-COUPON speed limit on worked / failed reports (T-6227): at most
// `maxPerHour` COUNTED reports of a kind per coupon per hour, whoever sends
// them. State is a per-process Map; `now` and the cap are parameters.
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

const T0 = Date.parse('2026-10-23T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const MAX = 3

beforeEach(() => {
    resetReportVelocityForTests()
    vi.mocked(Sentry.captureMessage).mockClear()
})

const admit = (kind: 'worked' | 'failed', coupon: string, now: number) =>
    admitCouponReportVelocity(kind, coupon, now, MAX)

describe('admitCouponReportVelocity', () => {
    it('counts up to the cap and refuses the next', () => {
        for (let n = 0; n < MAX; n++) {
            expect(admit('failed', '7', T0 + n)).toBe(true)
        }
        expect(admit('failed', '7', T0 + 10)).toBe(false)
        expect(admit('failed', '7', T0 + 11)).toBe(false)
    })

    it('kinds and coupons have their own counts', () => {
        for (let n = 0; n < MAX; n++) admit('failed', '7', T0)
        expect(admit('failed', '7', T0)).toBe(false)
        expect(admit('worked', '7', T0)).toBe(true)
        expect(admit('failed', '8', T0)).toBe(true)
    })

    it('the window rolls: an hour after the first counted report the coupon is open again, with a fresh count', () => {
        for (let n = 0; n < MAX; n++) admit('worked', '7', T0)
        expect(admit('worked', '7', T0 + HOUR - 1)).toBe(false)
        for (let n = 0; n < MAX; n++) {
            expect(admit('worked', '7', T0 + HOUR)).toBe(true)
        }
        expect(admit('worked', '7', T0 + HOUR)).toBe(false)
    })

    it('release gives a counted slot back, and is a no-op on an unknown coupon or a rolled window', () => {
        for (let n = 0; n < MAX; n++) admit('failed', '7', T0)
        releaseCouponReportVelocity('failed', '7', T0 + 1)
        expect(admit('failed', '7', T0 + 2)).toBe(true)
        expect(admit('failed', '7', T0 + 3)).toBe(false)

        releaseCouponReportVelocity('failed', '999', T0)
        releaseCouponReportVelocity('failed', '7', T0 + 2 * HOUR)
        // The rolled window's release did not free anything in a NEW window.
        expect(admit('failed', '7', T0 + 2 * HOUR)).toBe(true)
        expect(admit('failed', '999', T0)).toBe(true)
    })

    it('a cap hit is reported to Sentry once per coupon and kind per window, not once per refused report', () => {
        for (let n = 0; n < MAX; n++) admit('failed', '7', T0)
        for (let n = 0; n < 5; n++) admit('failed', '7', T0 + 1000 + n)

        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
        const [message, context] = vi.mocked(Sentry.captureMessage).mock
            .calls[0]!
        expect(message).toContain('velocity cap hit')
        expect(context).toMatchObject({
            level: 'warning',
            tags: { budget: 'report-velocity', reportKind: 'failed' },
            extra: { couponId: '7', maxPerHour: MAX },
        })
    })

    it('a Sentry event carries no reporter identity', () => {
        for (let n = 0; n < MAX + 1; n++) admit('worked', '7', T0)
        const serialized = JSON.stringify(
            vi.mocked(Sentry.captureMessage).mock.calls,
        )
        expect(serialized).not.toMatch(/userId|"ip"|203\.0\.113/)
    })

    it('Sentry events are throttled per kind (one a minute) however many coupons are flooded', () => {
        for (const coupon of ['1', '2', '3', '4']) {
            for (let n = 0; n <= MAX; n++) admit('failed', coupon, T0 + n)
        }
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)

        for (let n = 0; n <= MAX; n++) admit('failed', '5', T0 + 61_000)
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
    })

    it('a restarted process starts empty (state is per process): the documented residual', () => {
        for (let n = 0; n < MAX; n++) admit('failed', '7', T0)
        expect(admit('failed', '7', T0)).toBe(false)
        resetReportVelocityForTests() // what a deploy does to the Map
        expect(admit('failed', '7', T0)).toBe(true)
    })

    it('reads the cap from COUPON_REPORT_MAX_PER_COUPON_PER_HOUR (default 10) when none is passed', () => {
        let counted = 0
        while (admitCouponReportVelocity('failed', '77', T0)) counted++
        expect(counted).toBe(10)
    })
})
