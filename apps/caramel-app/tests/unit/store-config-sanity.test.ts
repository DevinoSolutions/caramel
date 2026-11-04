import { couponInputNamesOtherField } from '@/lib/catalog/storeConfigSanity'
import {
    getSupportedStoresPayload,
    resetSupportedStoresCache,
} from '@/lib/supportedStoresCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-10492 / T-10493 — a store config whose coupon input is a ZIP, email,
// search or gift-card-only field is not served to the extension. The positive
// cases are the coupon inputs prod store_configs actually held on 2026-10-29
// (24 of 3021 rows); gorjana.com's is why its shoppers never saw the prompt.

const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))

const PROD_NON_COUPON_INPUTS = [
    'input[aria-label="Search by zip code, city or state"]', // gorjana.com
    'input[placeholder="Search City, State or Zip Code"]', // dickeys.com
    '#select-store-zip', // dtlr.com
    'input[name="email"]', // shopmicas.com
    '#locationZipCode', // aerogarden.com
    '#email_016JB91TTR00000000000F463D', // brentwoodhome.com
    'input[name="ZIP"]', // bulletproof.com
    '#zip-code', // whirlpool.com
    'input[aria-label="Gift card code"]', // shopbala.com and three more
    '#gift-card-apply-gift-card-number', // mauijim.com
    '#homeDeliveryPostCodeInput', // majestic.co.uk
    '#insurancePostalCode', // contactsdirect.com
    'input[name="am_giftcard_code"]', // classicfootballshirts.co.uk
    '#search-field', // blackjackpizza.com
    '#dwfrm_ordertrack_emailorBillingZipCode', // lumens.com
    'input[placeholder="ZIP Code"]', // dollartree.com
    '#postalCode', // cartersoshkosh.ca
    '#zipCode', // everythingbutwater.com
    '#zipcode-native-label-placeholder', // fruitbouquets.com
    '#nq-searchINPUT', // houseofbruar.com
    '#sweepstakes-postal-code-condensed', // moen.com
]

const COUPON_INPUTS = [
    'input[aria-label="Discount code or gift card"]', // Shopify checkout's own box
    'input[placeholder="Enter promo code"]',
    '#coupon_code',
    'input[name="discount"]',
    '#dwfrm_cart_couponCode',
    '//input[@id="promo"]',
    '#promo-first-name', // names a promo box: kept, not guessed at
    'input[name="voucherCode"]',
    'input[aria-label="Gift card or discount code"]',
]

describe('couponInputNamesOtherField', () => {
    it.each(PROD_NON_COUPON_INPUTS)('%s is not a promo box', sel => {
        expect(couponInputNamesOtherField(sel)).toBe(true)
    })

    it.each(COUPON_INPUTS)('%s is a promo box', sel => {
        expect(couponInputNamesOtherField(sel)).toBe(false)
    })

    it('a missing selector is not flagged', () => {
        expect(couponInputNamesOtherField(null)).toBe(false)
        expect(couponInputNamesOtherField('')).toBe(false)
    })
})

function row(store_name: string, coupon_input_xpath: string) {
    return {
        store_name,
        show_input_xpath: null,
        dismiss_button_xpath: null,
        coupon_input_xpath,
        apply_button_xpath: 'button[type="submit"]',
        price_container_xpath: null,
        success_indicator_xpath: null,
        error_indicator_xpath: null,
        coupon_remove_xpath: null,
    }
}

beforeEach(() => {
    resetSupportedStoresCache()
    queryRawMock.mockReset()
})

describe('supported-stores payload', () => {
    it('leaves out a config whose coupon input is another field, so the store is config-less', async () => {
        queryRawMock.mockResolvedValue([
            row(
                'gorjana.com',
                'input[aria-label="Search by zip code, city or state"]',
            ),
            row('shopmicas.com', 'input[name="email"]'),
            row('example.com', 'input[placeholder="Enter promo code"]'),
        ])

        const { body } = await getSupportedStoresPayload(1_000)
        const domains = JSON.parse(body).supported.map(
            (e: { domain: string }) => e.domain,
        )

        expect(domains).toEqual(['example.com'])
    })
})
