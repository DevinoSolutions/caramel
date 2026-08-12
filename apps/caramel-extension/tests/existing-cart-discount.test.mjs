import { describe, expect, it } from 'vitest'
import { _existingCartDiscount } from '../coupon-runner.js'

// "None of our codes BEAT the cart" is not "nothing worked" — and reporting
// the second when the first is true is the most expensive lie this flow can
// tell.
//
// Observed twice on live stores (2026-08-05), both with the discount printed
// on screen directly behind our own modal:
//   goodr.com   — cart holding BOLDERBOULDER15 at -$8.00
//   1thrive.com — cart holding JESS20 at -$20.00, which WE had just won
// Both times the modal read "Auto-apply didn't stick this time. Copy a code and
// paste it in the store's promo box", and offered the ALREADY-APPLIED code as
// the first thing to copy. Following that advice is what actually costs the
// money: pasting another code into a Shopify promo box replaces the live one.
// The extension never dropped the discount itself — it just told the user to.
//
// probeCartJson() already returned this data; nothing consulted it.

describe('_existingCartDiscount', () => {
    it('names the code and amount already saving the user money', () => {
        const found = _existingCartDiscount({
            currency: 'USD',
            total_price: 15999,
            discount_codes: [
                { code: 'JESS20', amount: 2000, applicable: true },
            ],
        })
        expect(found?.code).toBe('JESS20')
        expect(found?.amountText).toContain('20.00')
    })

    it('reports nothing for a cart with no discount, so the normal copy list still shows', () => {
        expect(
            _existingCartDiscount({
                currency: 'USD',
                total_price: 4000,
                discount_codes: [],
            }),
        ).toBeNull()
    })

    it('ignores a code attached but worth zero, rather than announcing a saving', () => {
        // fanatical.com really does attach codes worth -$0.00; calling that a
        // saving would be the same dishonesty in the opposite direction.
        expect(
            _existingCartDiscount({
                currency: 'USD',
                discount_codes: [{ code: 'FMZ5', amount: 0, applicable: true }],
            }),
        ).toBeNull()
    })

    it('ignores a code the platform marks inapplicable', () => {
        expect(
            _existingCartDiscount({
                currency: 'USD',
                discount_codes: [
                    { code: 'DEAD', amount: 500, applicable: false },
                ],
            }),
        ).toBeNull()
    })

    it('accepts an older payload that omits the applicable flag', () => {
        const found = _existingCartDiscount({
            currency: 'USD',
            discount_codes: [{ code: 'LEGACY', amount: 800 }],
        })
        expect(found?.code).toBe('LEGACY')
    })

    it('renders the cart currency rather than assuming dollars', () => {
        const found = _existingCartDiscount({
            currency: 'GBP',
            discount_codes: [{ code: 'UKCODE', amount: 495 }],
        })
        // Intl may render "£4.95" or "GBP 4.95" depending on the ICU build;
        // both are honest, a "$" here would not be.
        expect(found?.amountText).not.toContain('$')
        expect(found?.amountText).toContain('4.95')
    })

    it('upper-cases the code so the copy list can filter it reliably', () => {
        // The live code must be dropped from "paste one of these" — matching is
        // case-insensitive because store payloads are inconsistent.
        expect(
            _existingCartDiscount({
                currency: 'USD',
                discount_codes: [{ code: 'jess20', amount: 2000 }],
            })?.code,
        ).toBe('JESS20')
    })

    // Every fixture above carries `amount` on the discount_codes entry. No live
    // Shopify cart measured on 2026-08-06 did: 100percentpure.com, goodr.com
    // and tog24.com all returned `{code, applicable}` and put the money in
    // `cart_level_discount_applications`. So this function reported "no
    // discount" for a cart that plainly had one, and the tests above could
    // never catch it — they pinned the fixture, not the platform.
    //
    // What that cost, measured on 100percentpure.com: the shopper arrived with
    // BARGAINBUDDY live at -$9.00, `arrivedWith` came back null, the restore
    // branch never ran, our probe replaced their code, and the card said
    // "Auto-apply didn't stick — copy a code and paste it in" while listing
    // codes worth $0.00 (HAIRCARE, GIFTMORE, COFFEE, SAVE15). Following that
    // advice replaces a live discount with nothing. This is verbatim the
    // failure the comment at the no-win branch says was fixed on 2026-08-05 —
    // fixed for carts that state an amount, never fixed for carts that don't.
    describe('a cart that records the money outside the code entry', () => {
        // Shape copied from 100percentpure.com's /cart.js, 2026-08-06.
        const REAL_CART = {
            currency: 'USD',
            total_price: 5100,
            total_discount: 900,
            discount_codes: [{ code: 'BARGAINBUDDY', applicable: true }],
            cart_level_discount_applications: [
                {
                    title: 'BARGAINBUDDY',
                    value_type: 'fixed_amount',
                    total_allocated_amount: 900,
                },
            ],
        }

        it('finds the discount the shopper actually arrived with', () => {
            const found = _existingCartDiscount(REAL_CART)

            expect(found?.code).toBe('BARGAINBUDDY')
            expect(found?.amountText).toContain('9.00')
        })

        it('matches the allocation by code even when several are applied', () => {
            const found = _existingCartDiscount({
                ...REAL_CART,
                total_discount: 1400,
                discount_codes: [
                    { code: 'SHIPFREE', applicable: false },
                    { code: 'BARGAINBUDDY', applicable: true },
                ],
                cart_level_discount_applications: [
                    { title: 'OTHER', total_allocated_amount: 500 },
                    { title: 'BARGAINBUDDY', total_allocated_amount: 900 },
                ],
            })

            expect(found?.code).toBe('BARGAINBUDDY')
            expect(found?.amountText).toContain('9.00')
        })

        it('falls back to the cart total only when one code could own it', () => {
            const found = _existingCartDiscount({
                currency: 'USD',
                total_discount: 1200,
                discount_codes: [{ code: 'SOLO', applicable: true }],
            })

            expect(found?.code).toBe('SOLO')
            expect(found?.amountText).toContain('12.00')
        })

        it('will not hand one code the credit for two', () => {
            // Two live codes and no per-code allocation: attributing the whole
            // total to whichever came first would name a figure we cannot
            // stand behind, and it is the figure the shopper is told.
            expect(
                _existingCartDiscount({
                    currency: 'USD',
                    total_discount: 1200,
                    discount_codes: [
                        { code: 'ONE', applicable: true },
                        { code: 'TWO', applicable: true },
                    ],
                }),
            ).toBeNull()
        })

        it('still ignores the seven dead codes a probe run leaves behind', () => {
            // Measured on goodr.com: probing does not clear earlier entries,
            // it only changes which one is applicable. The rejected ones must
            // not be mistaken for the shopper's own discount.
            const found = _existingCartDiscount({
                currency: 'USD',
                total_discount: 2400,
                discount_codes: [
                    { code: 'DWELL10', applicable: false },
                    { code: 'DEMOTED', applicable: false },
                    { code: 'BOLDERBOULDER15', applicable: true },
                    { code: 'TRN', applicable: false },
                ],
                cart_level_discount_applications: [
                    { title: 'BOLDERBOULDER15', total_allocated_amount: 2400 },
                ],
            })

            expect(found?.code).toBe('BOLDERBOULDER15')
        })

        it('reports nothing when the platform allocated nothing', () => {
            // tog24.com: codes attach, every one applicable:false, no money.
            expect(
                _existingCartDiscount({
                    currency: 'USD',
                    total_discount: 0,
                    discount_codes: [
                        { code: 'Summer15', applicable: false },
                        { code: 'TIKTOK10', applicable: false },
                    ],
                    cart_level_discount_applications: [],
                }),
            ).toBeNull()
        })
    })

    it('survives a missing or malformed cart without throwing', () => {
        expect(_existingCartDiscount(null)).toBeNull()
        expect(_existingCartDiscount({})).toBeNull()
        expect(
            _existingCartDiscount({ discount_codes: 'not-an-array' }),
        ).toBeNull()
        expect(_existingCartDiscount({ discount_codes: [null, {}] })).toBeNull()
    })
})
