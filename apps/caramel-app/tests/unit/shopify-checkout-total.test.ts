import { describe, expect, it } from 'vitest'

import {
    SHOPIFY_CHECKOUT_TOTAL,
    servedPriceContainer,
} from '@/lib/catalog/shopifyCheckoutTotal'

// T-9860: the rows below are the shapes prod served on 2026-11-06.
const REDUCTIONS = 'input[name="reductions"]'

describe('servedPriceContainer', () => {
    it('puts the one-page checkout total first on an old-family Shopify checkout row', () => {
        const legacy =
            '[data-checkout-payment-due-target], .payment-due__price, [data-checkout-total-target]'

        expect(servedPriceContainer(REDUCTIONS, legacy)).toBe(
            `${SHOPIFY_CHECKOUT_TOTAL}, ${legacy}`,
        )
    })

    it('gives a Shopify checkout row with no total the one-page checkout total', () => {
        expect(servedPriceContainer(REDUCTIONS, null)).toBe(
            SHOPIFY_CHECKOUT_TOTAL,
        )
        expect(servedPriceContainer(REDUCTIONS, '  ')).toBe(
            SHOPIFY_CHECKOUT_TOTAL,
        )
    })

    it('matches the reductions input however the row quotes it, alone or in a list', () => {
        for (const input of [
            "input[name='reductions']",
            'input[name=reductions]',
            'input[name="reductions"], input[name="discount"]',
            'input[name="discount"], input[name="reductions"]',
        ])
            expect(servedPriceContainer(input, null)).toBe(
                SHOPIFY_CHECKOUT_TOTAL,
            )
    })

    it('leaves a row that already serves the hook untouched', () => {
        expect(servedPriceContainer(REDUCTIONS, SHOPIFY_CHECKOUT_TOTAL)).toBe(
            SHOPIFY_CHECKOUT_TOTAL,
        )
    })

    it('leaves an XPath total alone: it cannot share a list with CSS', () => {
        const xpath =
            '//div[@role="row"][.//strong[normalize-space(text())="Total"]]//div[@role="cell"]'

        expect(servedPriceContainer(REDUCTIONS, xpath)).toBe(xpath)
    })

    it('never touches a store that is not a Shopify checkout', () => {
        expect(servedPriceContainer('#coupon_code', '.order-total')).toBe(
            '.order-total',
        )
        expect(servedPriceContainer('#coupon_code', null)).toBeNull()
        expect(servedPriceContainer(null, null)).toBeNull()
    })
})
