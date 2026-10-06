import {
    isUnusableCouponTitle,
    shopperCouponTitle,
} from '@/lib/couponTitleText'
import { describe, expect, it } from 'vitest'

// The titles below are copied from the live catalog (2026-09-30, the store
// pages with the most Search Console impressions). See couponTitleText.ts.

const row = (over: Partial<Parameters<typeof shopperCouponTitle>[0]> = {}) => ({
    title: 'CODE',
    code: 'EHLOVE20',
    site: 'eharmony.ca',
    discount_type: null,
    discount_amount: null,
    ...over,
})

describe('isUnusableCouponTitle', () => {
    it.each([
        'CODE',
        'SALE',
        'code',
        ' Deal ',
        '',
        '   ',
        'Promo Code',
        "30% off • 29 Competitor Deals • Last Checked: Just now Top codes Best deals Activity Saving hacks FAQ Today's Groupon promo code",
        "10% off • 154 Competitor Deals • Last Checked: Just now Top codes Activity Saving hacks FAQ Today's Coursera promo codes & verif",
        '15% off Code Code Verified Storewide Show Code 15% Off (Storewide) at Anthropologie w/Code Last used: Recently Uses today: 0 Hea',
    ])('rejects %j', title => {
        expect(isUnusableCouponTitle(title)).toBe(true)
    })

    it.each([
        'Anthropologie Coupon: 20% Off Your Order',
        '15% Off Your Order',
        'Free Shipping with Code',
        '20% Off (Storewide) at DHC',
        'Medium 2-Topping Only $8.99',
        // A word that merely CONTAINS a placeholder is a real title.
        'Coupon for new customers',
        'Save 25%',
    ])('keeps %j', title => {
        expect(isUnusableCouponTitle(title)).toBe(false)
    })
})

describe('isUnusableCouponTitle with the store', () => {
    it.each([
        ['amazon.com coupon', 'amazon.com'],
        ['Amazon Promo Code', 'amazon.com'],
        ['adidas.com  coupons', 'adidas.com'],
        ['argos discount code', 'argos.co.uk'],
    ])('rejects %j on %s', (title, site) => {
        expect(isUnusableCouponTitle(title, site)).toBe(true)
    })

    it.each([
        ['amazon.com coupon: 20% off Echo', 'amazon.com'],
        ['Amazon Basics sale', 'amazon.com'],
        // Another store's name is not this store's placeholder.
        ['walmart.com coupon', 'amazon.com'],
    ])('keeps %j on %s', (title, site) => {
        expect(isUnusableCouponTitle(title, site)).toBe(false)
    })
})

describe('shopperCouponTitle', () => {
    it('replaces "<store> coupon" with a title built from the row', () => {
        expect(
            shopperCouponTitle(
                row({
                    title: 'amazon.com coupon',
                    site: 'amazon.com',
                    code: 'SAVE20',
                    discount_type: 'PERCENTAGE',
                    discount_amount: 20,
                }),
            ),
        ).toBe('20% off at amazon.com')
    })

    it('keeps a real title, whitespace-normalized', () => {
        expect(
            shopperCouponTitle(row({ title: '  15% Off   Your Order ' })),
        ).toBe('15% Off Your Order')
    })

    it('builds a percent-off title from the row for a placeholder', () => {
        expect(
            shopperCouponTitle(
                row({
                    site: 'coursera.org',
                    discount_type: 'PERCENTAGE',
                    discount_amount: 10,
                    title: "10% off • 154 Competitor Deals • Last Checked: Just now Top codes Activity Saving hacks FAQ Today's Coursera promo codes & verif",
                }),
            ),
        ).toBe('10% off at coursera.org')
    })

    it('never states a fixed amount: the catalog has no currency, so it names the code', () => {
        expect(
            shopperCouponTitle(
                row({
                    site: 'boots.co.uk',
                    discount_type: 'CASH',
                    discount_amount: 10,
                }),
            ),
        ).toBe('boots.co.uk promo code EHLOVE20')
    })

    it('names the code when the row has no usable amount', () => {
        expect(shopperCouponTitle(row())).toBe(
            'eharmony.ca promo code EHLOVE20',
        )
    })

    it('never repeats a producer-error percentage (100% or more) as a title', () => {
        expect(
            shopperCouponTitle(
                row({ discount_type: 'PERCENTAGE', discount_amount: 150 }),
            ),
        ).toBe('eharmony.ca promo code EHLOVE20')
    })

    it('a blank code still yields a title, not a dangling space', () => {
        expect(shopperCouponTitle(row({ code: '  ' }))).toBe(
            'eharmony.ca promo code',
        )
    })
})
