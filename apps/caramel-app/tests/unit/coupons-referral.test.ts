import { isReferralCoupon } from '@/lib/coupons'
import { describe, expect, it } from 'vitest'

// isReferralCoupon is word-bounded on purpose: the negatives are real prod
// titles/descriptions (2026-10-17) that a substring match would have wrongly
// swept out of the catalog.

describe('isReferralCoupon', () => {
    it.each([
        ['Referral Discount, Code In The Link', null],
        ['Refer a Friend Select Items', null],
        ['Enjoy 20% off with a friend referral', null],
        ['Refer-a-Friend: $10 off', null],
        ['Referrals earn store credit', null],
        ['$20 off your first order', 'Use the code in the link to save'],
        ['Welcome offer', 'You were invited by a friend'],
        ['Welcome offer', 'Enter the INVITE CODE at checkout'],
        ['REFERRAL BONUS', 'x'],
    ])('flags %j / %j', (title, description) => {
        expect(isReferralCoupon({ title, description })).toBe(true)
    })

    it.each([
        ['Avis Preferred members', null],
        ["Musician's Friend code", null],
        ['Wedding invitations 20% off', null],
        ['Evite Pro 15% off', null],
        ['Get 10% Off Your Purchase', null],
        ['Get 10% Off Your Purchase', 'Free shipping over $50'],
        ['Zazzle invitations', ''],
    ])('does not flag %j / %j', (title, description) => {
        expect(isReferralCoupon({ title, description })).toBe(false)
    })

    it('matches on the description alone', () => {
        expect(
            isReferralCoupon({
                title: '10% off',
                description: 'Refer a friend',
            }),
        ).toBe(true)
    })
})
