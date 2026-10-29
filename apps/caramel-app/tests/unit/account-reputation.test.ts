import { isEstablishedAccount } from '@/lib/accountReputation'
import { describe, expect, it } from 'vitest'

// The one definition of an "established" account (T-6222 / T-6227). Pure over
// its inputs: `now` and the age gate are parameters, so no fake clock.
const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('isEstablishedAccount', () => {
    it('an account older than the gate is established; a younger one is not', () => {
        expect(isEstablishedAccount(new Date(NOW - 8 * DAY), NOW, 7)).toBe(true)
        expect(isEstablishedAccount(new Date(NOW - 6 * DAY), NOW, 7)).toBe(
            false,
        )
    })

    it('exactly the gate old counts (the boundary is inclusive)', () => {
        expect(isEstablishedAccount(new Date(NOW - 7 * DAY), NOW, 7)).toBe(true)
        expect(isEstablishedAccount(new Date(NOW - 7 * DAY + 1), NOW, 7)).toBe(
            false,
        )
    })

    it('accepts an ISO string as well as a Date', () => {
        expect(isEstablishedAccount('2026-01-01T00:00:00.000Z', NOW, 7)).toBe(
            true,
        )
    })

    it('a missing or unparseable creation time is NOT established (fail closed)', () => {
        expect(isEstablishedAccount(null, NOW, 7)).toBe(false)
        expect(isEstablishedAccount(undefined, NOW, 7)).toBe(false)
        expect(isEstablishedAccount('not a date', NOW, 7)).toBe(false)
    })

    it('an account created in the future is not established', () => {
        expect(isEstablishedAccount(new Date(NOW + DAY), NOW, 7)).toBe(false)
    })

    it('a gate of 0 days switches the guard off: every dated account is established', () => {
        expect(isEstablishedAccount(new Date(NOW), NOW, 0)).toBe(true)
    })

    it('defaults the gate to the COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS env (7)', () => {
        expect(isEstablishedAccount(new Date(Date.now() - 8 * DAY))).toBe(true)
        expect(isEstablishedAccount(new Date(Date.now() - 1 * DAY))).toBe(false)
    })
})
