import { scrubCartItems } from '@/lib/cartItemScrub'
import {
    hasCodeShapedToken,
    redactCodeShapedTokens,
    redactStoreReason,
} from '@/lib/codeShapedTokens'
import { describe, expect, it } from 'vitest'

// The rule is documented in the header of src/lib/codeShapedTokens.ts: a token
// is redacted when it MIXES letters and digits (ordinals aside), and, for store
// reasons only, when it is SHOUTED (4+ uppercase letters, not allowlisted).
// Amounts, percentages and pure numbers are never touched.

describe('redactStoreReason', () => {
    it('keeps the catalog code and redacts the shopper code beside it', () => {
        expect(
            redactStoreReason(
                'Code FALL20 cannot be combined with MYCODE5',
                'FALL20',
            ),
        ).toBe('Code FALL20 cannot be combined with [code]')
    })

    it('compares the catalog code case-insensitively, both ways', () => {
        expect(redactStoreReason('fall20 is not valid', 'FALL20')).toBe(
            'fall20 is not valid',
        )
        expect(redactStoreReason('FALL20 is not valid', 'fall20')).toBe(
            'FALL20 is not valid',
        )
    })

    it('keeps a hyphenated or underscored catalog code whole', () => {
        expect(
            redactStoreReason('SAVE-10 and SAVE_10 and OTHER-10', 'SAVE-10'),
        ).toBe('SAVE-10 and [code] and [code]')
    })

    it('keeps every token of a multi-token catalog code', () => {
        expect(
            redactStoreReason('SAVE 10 conflicts with VIP9', 'SAVE 10'),
        ).toBe('SAVE 10 conflicts with [code]')
    })

    it('redacts everything code-shaped when there is no catalog code to keep', () => {
        expect(redactStoreReason('FALL20 and MYCODE5', null)).toBe(
            '[code] and [code]',
        )
    })

    it('leaves plain English reasons unchanged', () => {
        for (const reason of [
            'This code has expired',
            'Minimum spend $50 not met',
            'Coupon is not valid for sale items',
            'Order total must be at least 25.00 CAD',
            'Only valid on orders shipped within 5-7 days',
            'Free shipping over 100 USD',
            'You have used this offer 2026 times',
            '',
        ]) {
            expect(redactStoreReason(reason, 'FALL20')).toBe(reason)
        }
    })

    it('keeps amounts, percentages, years and ordinals', () => {
        const reason =
            '$50 minimum, 20% off, valid until 2026, 1,000 uses, 1st order, 22nd item'
        expect(redactStoreReason(reason, null)).toBe(reason)
    })

    it('redacts tokens that mix letters and digits, whatever the case', () => {
        expect(
            redactStoreReason(
                'try SAVE10 or save10 or 10OFF or Welcome5',
                null,
            ),
        ).toBe('try [code] or [code] or [code] or [code]')
    })

    it('redacts shouted words of 4+ letters but not the allowlisted ones', () => {
        expect(
            redactStoreReason(
                'MYCODE is not valid. FREE shipping, SALE items, 5% OFF, pay in USD, CAD, EUR or GBP',
                null,
            ),
        ).toBe(
            '[code] is not valid. FREE shipping, SALE items, 5% OFF, pay in USD, CAD, EUR or GBP',
        )
    })

    it('does not treat three-letter caps, title case or short tokens as codes', () => {
        const reason = 'The VIP Tier needs A1 and ID: Welcome, Summer'
        expect(redactStoreReason(reason, null)).toBe(reason)
    })

    it('redacts a shouted token with a hyphen or underscore inside', () => {
        expect(redactStoreReason('SAVE-NOW and BACK_TO_SCHOOL', null)).toBe(
            '[code] and [code]',
        )
    })

    it('redacts a code in any script, not only ASCII', () => {
        expect(redactStoreReason('Code ÉTÉ20 introuvable', null)).toBe(
            'Code [code] introuvable',
        )
    })

    it('does not mistake caseless scripts for shouted words', () => {
        expect(redactStoreReason('代码已过期了', null)).toBe('代码已过期了')
    })

    it('redacts a very long token instead of skipping it', () => {
        const long = `A1${'b'.repeat(80)}`
        expect(redactStoreReason(`see ${long} now`, null)).toBe(
            'see [code] now',
        )
    })

    it('hasCodeShapedToken mirrors whether redaction would change the text', () => {
        expect(
            hasCodeShapedToken('Minimum spend $50', { shoutingWords: true }),
        ).toBe(false)
        expect(
            hasCodeShapedToken('with MYCODE5', { shoutingWords: true }),
        ).toBe(true)
        expect(hasCodeShapedToken('with MYCODE', { shoutingWords: true })).toBe(
            true,
        )
        expect(hasCodeShapedToken('with MYCODE')).toBe(false)
    })
})

describe('redactCodeShapedTokens (mixed tokens only, the default)', () => {
    it('leaves shouted words alone: page labels are full of them', () => {
        const text = 'APPLY ORDER SUMMARY NIKE AIR MAX'
        expect(redactCodeShapedTokens(text)).toBe(text)
    })

    it('redacts only the mixed token', () => {
        expect(redactCodeShapedTokens('Remove SAVE10 now')).toBe(
            'Remove [code] now',
        )
    })
})

describe('scrubCartItems', () => {
    it('drops discount-vocabulary rows whole, in any case', () => {
        expect(
            scrubCartItems([
                'Discount: SAVE10',
                'Blue Widget',
                'COUPON applied',
                'Promo Code FALL20',
                'Gift voucher',
                'Code applied: X',
                'Total savings $5',
            ]),
        ).toEqual(['Blue Widget'])
    })

    it('redacts mixed letter+digit tokens in the remaining titles', () => {
        expect(
            scrubCartItems(['SAVE10', 'Dell XPS13 Laptop', 'USB-C Cable']),
        ).toEqual(['[code]', 'Dell [code] Laptop', 'USB-C Cable'])
    })

    it('keeps ordinary product titles, shouted words and amounts', () => {
        const items = ['NIKE AIR MAX 270 - $120.00', 'Pack of 3 socks']
        expect(scrubCartItems(items)).toEqual(items)
    })
})
