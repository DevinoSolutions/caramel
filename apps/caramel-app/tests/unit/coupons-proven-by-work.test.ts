import {
    COUPON_STATUSES,
    STATUS_META,
    WORKED_AT_CLOCK_SKEW_TOLERANCE_MS,
    WORKED_VERIFIED_WINDOW_HOURS,
    WORKED_VERIFIED_WINDOW_MS,
    couponBadge,
    discountBadgeText,
    isRecentlyWorked,
    workedAgeMs,
} from '@/lib/coupons'
import { describe, expect, it } from 'vitest'

// The proof-by-use rule (lib/coupons.ts, 2026-09-30): a shopper's successful
// apply within the last 24h makes an UNVERIFIED code display as Verified, so
// the /coupons card can no longer show a green "worked 0h ago" line beside an
// "Unverified" badge. Every case passes an explicit `now`.
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('the proof window constants', () => {
    it('is 24 hours, and the ms form agrees with the hours form (the SQL inlines the hours, the popup reads the ms)', () => {
        expect(WORKED_VERIFIED_WINDOW_HOURS).toBe(24)
        expect(WORKED_VERIFIED_WINDOW_MS).toBe(24 * HOUR)
        expect(WORKED_AT_CLOCK_SKEW_TOLERANCE_MS).toBe(5 * MINUTE)
    })
})

describe('workedAgeMs', () => {
    it('absent / unparseable → null', () => {
        expect(workedAgeMs(null, NOW)).toBeNull()
        expect(workedAgeMs(undefined, NOW)).toBeNull()
        expect(workedAgeMs('', NOW)).toBeNull()
        expect(workedAgeMs('nope', NOW)).toBeNull()
    })

    it('a past timestamp → its age; a Date works like an ISO string', () => {
        expect(workedAgeMs(ago(3 * HOUR), NOW)).toBe(3 * HOUR)
        expect(workedAgeMs(new Date(NOW - HOUR), NOW)).toBe(HOUR)
    })

    it('slightly in the future (within the skew tolerance) → 0; beyond it → null', () => {
        expect(workedAgeMs(ago(-WORKED_AT_CLOCK_SKEW_TOLERANCE_MS), NOW)).toBe(
            0,
        )
        expect(
            workedAgeMs(ago(-WORKED_AT_CLOCK_SKEW_TOLERANCE_MS - 1), NOW),
        ).toBeNull()
    })
})

describe('isRecentlyWorked', () => {
    it('true from "just now" up to and including exactly 24h', () => {
        expect(isRecentlyWorked(ago(0), NOW)).toBe(true)
        expect(isRecentlyWorked(ago(23 * HOUR), NOW)).toBe(true)
        expect(isRecentlyWorked(ago(WORKED_VERIFIED_WINDOW_MS), NOW)).toBe(true)
    })

    it('false past 24h, with no signal, or with a bogus future signal', () => {
        expect(isRecentlyWorked(ago(WORKED_VERIFIED_WINDOW_MS + 1), NOW)).toBe(
            false,
        )
        expect(isRecentlyWorked(null, NOW)).toBe(false)
        expect(isRecentlyWorked(ago(-HOUR), NOW)).toBe(false)
    })
})

describe('couponBadge — the badge a card DISPLAYS', () => {
    const verified = { ...STATUS_META.valid, provenByRecentWork: true }

    it('an Unverified code (pending / retry) that worked in the last 24h shows the Verified check badge', () => {
        for (const status of COUPON_STATUSES.filter(
            s => STATUS_META[s].tier === 'grey',
        )) {
            expect(couponBadge(status, ago(10 * MINUTE), NOW)).toEqual(verified)
        }
        expect(verified.label).toBe('✓ Verified')
        expect(verified.tier).toBe('green')
    })

    it('a status-less code with a recent apply is Verified; with no apply it has no badge', () => {
        expect(couponBadge(undefined, ago(HOUR), NOW)).toEqual(verified)
        expect(couponBadge(null, null, NOW)).toBeNull()
    })

    it('an Unverified code whose last apply is older than 24h (or absent) stays Unverified', () => {
        const unverified = { ...STATUS_META.pending, provenByRecentWork: false }
        expect(couponBadge('pending', ago(25 * HOUR), NOW)).toEqual(unverified)
        expect(couponBadge('pending', null, NOW)).toEqual(unverified)
    })

    it('amber (restricted) and red (dead) are NEVER upgraded, even with a fresh apply', () => {
        for (const status of COUPON_STATUSES.filter(s =>
            ['amber', 'red'].includes(STATUS_META[s].tier),
        )) {
            expect(couponBadge(status, ago(MINUTE), NOW)).toEqual({
                ...STATUS_META[status],
                provenByRecentWork: false,
            })
        }
    })

    it('a pipeline-verified code stays the catalog badge (not flagged as proven-by-use)', () => {
        expect(couponBadge('valid', ago(MINUTE), NOW)).toEqual({
            ...STATUS_META.valid,
            provenByRecentWork: false,
        })
    })

    it('a status outside the vocabulary (inherited Object keys included) is treated as no status', () => {
        expect(couponBadge('toString', null, NOW)).toBeNull()
        expect(couponBadge('brand_new_status', ago(MINUTE), NOW)).toEqual(
            verified,
        )
    })
})

describe('discountBadgeText', () => {
    it('percent, fixed, and the honest no-amount null', () => {
        expect(discountBadgeText('PERCENTAGE', 15)).toBe('15%')
        expect(discountBadgeText('CASH', 20)).toBe('$20')
        expect(discountBadgeText(null, 5)).toBe('$5')
        expect(discountBadgeText('PERCENTAGE', null)).toBeNull()
        expect(discountBadgeText('PERCENTAGE', 0)).toBeNull()
    })
})
