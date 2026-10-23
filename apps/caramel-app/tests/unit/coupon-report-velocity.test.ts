import {
    admitCouponReportVelocity,
    releaseCouponReportVelocity,
    resetReportVelocityForTests,
    velocityEntryCountForTests,
    velocityTierOf,
    type VelocityKind,
    type VelocityTier,
} from '@/lib/couponReportVelocity'
import * as Sentry from '@sentry/nextjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-COUPON speed limit on worked / failed reports (T-6227): at most
// `maxPerHour` COUNTED reports of a kind per coupon per hour per bucket
// (established accounts vs low-trust reporters), whoever sends them. State is a
// per-process Map; `now` and the cap are parameters.
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))

const T0 = Date.parse('2026-10-23T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const MAX = 3

beforeEach(() => {
    resetReportVelocityForTests()
    vi.mocked(Sentry.captureMessage).mockClear()
})

const admit = (
    kind: VelocityKind,
    coupon: string,
    now: number,
    tier: VelocityTier = 'low',
) => admitCouponReportVelocity(kind, coupon, tier, now, MAX)

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

    it('low-trust and established reporters have SEPARATE buckets: a swarm cannot starve established reports', () => {
        for (let n = 0; n < MAX; n++) admit('failed', '7', T0, 'low')
        expect(admit('failed', '7', T0, 'low')).toBe(false)
        for (let n = 0; n < MAX; n++) {
            expect(admit('failed', '7', T0, 'established')).toBe(true)
        }
        expect(admit('failed', '7', T0, 'established')).toBe(false)
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
        releaseCouponReportVelocity('failed', '7', 'low', T0 + 1)
        expect(admit('failed', '7', T0 + 2)).toBe(true)
        expect(admit('failed', '7', T0 + 3)).toBe(false)

        releaseCouponReportVelocity('failed', '999', 'low', T0)
        releaseCouponReportVelocity('failed', '7', 'low', T0 + 2 * HOUR)
        // The rolled window's release did not free anything in a NEW window.
        expect(admit('failed', '7', T0 + 2 * HOUR)).toBe(true)
        expect(admit('failed', '999', T0)).toBe(true)
    })

    it("release of a bucket's only slot DELETES the entry: probing unknown ids leaves nothing behind to fill the table", () => {
        for (let n = 0; n < 500; n++) {
            admit('failed', `probe-${n}`, T0)
            releaseCouponReportVelocity('failed', `probe-${n}`, 'low', T0)
        }
        expect(velocityEntryCountForTests()).toBe(0)

        // An entry that still has a counted report, or a refusal, stays.
        admit('failed', '7', T0)
        admit('failed', '7', T0)
        releaseCouponReportVelocity('failed', '7', 'low', T0)
        expect(velocityEntryCountForTests()).toBe(1)
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
            tags: {
                budget: 'report-velocity',
                reportKind: 'failed',
                reporterTier: 'low',
            },
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

    it("reads each bucket's cap from the env when none is passed: established 10, low-trust 5", () => {
        const count = (tier: VelocityTier) => {
            let counted = 0
            while (admitCouponReportVelocity('failed', `env-${tier}`, tier, T0))
                counted++
            return counted
        }
        expect(count('established')).toBe(10)
        expect(count('low')).toBe(5)
    })
})

describe('velocityTierOf', () => {
    it('only an established account is in the established bucket', () => {
        expect(
            velocityTierOf({ kind: 'user', userId: 'u', established: true }),
        ).toBe('established')
        expect(
            velocityTierOf({ kind: 'user', userId: 'u', established: false }),
        ).toBe('low')
        expect(velocityTierOf({ kind: 'ip', ip: '203.0.113.1' })).toBe('low')
    })
})
