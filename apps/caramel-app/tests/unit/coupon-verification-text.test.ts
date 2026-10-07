import { shopperVerificationText } from '@/lib/couponVerificationText'
import { describe, expect, it } from 'vitest'

// Every string below is a real `coupons.verification_message` from prod
// (2026-09-26), on a coupon the listings serve. Before this rule the extension
// popup printed each restricted one under the coupon, and both coupon cards
// put any of them in the badge tooltip.

describe('shopperVerificationText: verifier log never reaches a shopper', () => {
    it.each([
        // retry (34,102 visible rows)
        ['retry', 'Verification timed out after 120s'],
        [
            'retry',
            'API request failed: Failed to perform, curl: (56) CONNECT tunnel failed, response 407',
        ],
        ['retry', 'Headful browser launch failed'],
        [
            'retry',
            'Coupon input selector was not found on https://humehealth.com/',
        ],
        // valid (19,463 visible rows)
        [
            'valid',
            'Discount code accepted (Shopify cart.json; cart 1 item / 45.00 USD)',
        ],
        ['valid', 'Coupon accepted (structural discriminator)'],
        ['valid', 'Discount code classified as valid (HTML+LLM)'],
        // a store sentence on a non-restricted coupon still explains nothing
        ['valid', 'Thank you for subscribing!'],
        ['retry', 'Unable to classify validation result: No items in basket.'],
    ])('%s: %s → null', (status, message) => {
        expect(shopperVerificationText(status, message)).toBeNull()
    })

    it.each([
        'basket.error.bagNotFound',
        'NO_ITEMS_QUALIFY',
        'Could not fully verify',
        'code accepted (not rejected as invalid) but produced no discount on the seeded cart - likely expired, product/category restricted',
        'Recognized but does not qualify (flags: [{"message":"NO_ITEMS_QUALIFY","type":"informational"}])',
        'Sorry that promotion code cannot be applied [DiscountCodeErrorDiscountCodeNonApplicable]',
        'Variable "$cart_id" of required type "String!" was not provided.',
        "Error: We can't find your cart. Try refreshing or restarting.",
        'Promo code recognized but not applicable to current cart (error 115: product/eligibility restriction)',
        'Coupon requires minimum order total of $10; current cart is $0',
        'Sorry, this discount code can&#039;t be applied. All items in your basket are on offer.',
        'Your cart is currently empty',
        'Cart does not contain products.',
        'Bag not found',
        'Promo',
        'Unauthorized',
    ])('product_restriction: %s → null', message => {
        expect(
            shopperVerificationText('product_restriction', message),
        ).toBeNull()
    })

    it('null and blank stay null', () => {
        expect(shopperVerificationText('product_restriction', null)).toBeNull()
        expect(shopperVerificationText('product_restriction', '   ')).toBeNull()
    })
})

describe("shopperVerificationText: a restricted coupon keeps the store's own words", () => {
    it.each([
        'Your cart contains ineligible products.',
        'Sorry, your promo code is not applicable to this order.',
        'You may not use coupons with a guest account.',
        'Not applicable to current cart contents',
        'Coupon requires minimum order total of $10',
        'Eligible item total has to be greater than $99.00',
    ])('product_restriction: %s', message => {
        expect(shopperVerificationText('product_restriction', message)).toBe(
            message,
        )
    })

    it('collapses whitespace the store page left in', () => {
        expect(
            shopperVerificationText(
                'category_restricted',
                '  Items do not\n qualify for this promo.  ',
            ),
        ).toBe('Items do not qualify for this promo.')
    })
})
