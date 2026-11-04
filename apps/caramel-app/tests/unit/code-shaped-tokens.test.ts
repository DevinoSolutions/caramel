import { scrubCartItems } from '@/lib/cartItemScrub'
import {
    hasCodeShapedToken,
    redactCodeShapedTokens,
    redactStoreReason,
    stripFormatChars,
} from '@/lib/codeShapedTokens'
import { describe, expect, it } from 'vitest'

// The rule is documented in the header of src/lib/codeShapedTokens.ts: a token
// is redacted when it MIXES letters with digits or `#` (ordinals aside), and,
// for store reasons only, when it is an alphabetic ALL-CAPS token that is quoted
// or follows code / coupon / promo / voucher. Amounts, percentages and pure
// numbers are never touched; invisible format characters are stripped first.

const ZWSP = '​'

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

    it('keeps a hyphenated catalog code whole, not its look-alikes', () => {
        expect(
            redactStoreReason('SAVE-10 and SAVE_10 and OTHER-10', 'SAVE-10'),
        ).toBe('SAVE-10 and [code] and [code]')
    })

    it('protects only the COMPLETE catalog code: its constituent tokens get nothing', () => {
        const catalog = 'VIP9 FALL20'
        expect(redactStoreReason('VIP9 FALL20 is not valid', catalog)).toBe(
            'VIP9 FALL20 is not valid',
        )
        expect(redactStoreReason('VIP9 stacks with FALL20', catalog)).toBe(
            '[code] stacks with [code]',
        )
        expect(redactStoreReason('VIP9 conflicts with MYCODE5', catalog)).toBe(
            '[code] conflicts with [code]',
        )
    })

    it('does not protect the catalog code inside a longer token', () => {
        expect(redactStoreReason('XFALL20 and FALL20Y', 'FALL20')).toBe(
            '[code] and [code]',
        )
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

    it('keeps realistic UPPERCASE store messages intact and triggers no lookup', () => {
        for (const reason of [
            'MINIMUM SPEND NOT MET',
            'COUPON NOT VALID',
            'THIS COUPON CODE IS INVALID',
            'PROMO CODE HAS EXPIRED',
            'COUPON CODE ALREADY USED',
            'CODE NOT FOUND',
            'ORDER TOTAL TOO LOW FOR THIS OFFER',
            'FREE SHIPPING ON ORDERS OVER 100 USD',
            'THE VOUCHER CAN NOT BE APPLIED TO SALE ITEMS',
        ]) {
            expect(redactStoreReason(reason, 'FALL20')).toBe(reason)
            expect(hasCodeShapedToken(reason, { contextualCaps: true })).toBe(
                false,
            )
        }
    })

    it('redacts an ALL-CAPS token that follows code / coupon / promo / voucher', () => {
        expect(redactStoreReason('code MYCODE is invalid', null)).toBe(
            'code [code] is invalid',
        )
        expect(redactStoreReason('Coupon: MYCODE is not valid', null)).toBe(
            'Coupon: [code] is not valid',
        )
        expect(redactStoreReason('Promo "MYCODE" expired', null)).toBe(
            'Promo "[code]" expired',
        )
        expect(redactStoreReason('VOUCHER SUMMER-FUN EXPIRED', null)).toBe(
            'VOUCHER [code] EXPIRED',
        )
        expect(redactStoreReason('COUPON CODE MYCODE IS INVALID', null)).toBe(
            'COUPON CODE [code] IS INVALID',
        )
    })

    it('redacts a QUOTED ALL-CAPS token wherever it appears', () => {
        expect(
            redactStoreReason('We could not apply "MYCODE" today', null),
        ).toBe('We could not apply "[code]" today')
        expect(redactStoreReason("Unknown offer 'SUMMER'", null)).toBe(
            "Unknown offer '[code]'",
        )
        expect(redactStoreReason('“MYCODE” is unknown', null)).toBe(
            '“[code]” is unknown',
        )
    })

    it('keeps allowlisted words even when quoted or after the context word', () => {
        expect(redactStoreReason('code "EXPIRED" and coupon: USD', null)).toBe(
            'code "EXPIRED" and coupon: USD',
        )
    })

    it('does not redact a bare uppercase word with no context, or title-case', () => {
        const reason = 'The VIP Tier needs A1 and ID: Welcome, Summer, MYCODE'
        expect(redactStoreReason(reason, null)).toBe(reason)
    })

    it('matches the context word in any case but still checks the candidate shape', () => {
        expect(redactStoreReason('cOUPON MYCODE is invalid', null)).toBe(
            'cOUPON [code] is invalid',
        )
        expect(redactStoreReason('PROMO mycode is invalid', null)).toBe(
            'PROMO mycode is invalid',
        )
    })

    it('keeps the catalog code when it follows the context word', () => {
        expect(redactStoreReason('code FALL20 is invalid', 'FALL20')).toBe(
            'code FALL20 is invalid',
        )
        expect(redactStoreReason('code MYCODE is invalid', 'FALL20')).toBe(
            'code [code] is invalid',
        )
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

    it('redacts a token that mixes letters with the extension digit mask', () => {
        expect(redactStoreReason('Remove SAVE## now', null)).toBe(
            'Remove [code] now',
        )
        expect(redactStoreReason('Order Summary ## total ####', null)).toBe(
            'Order Summary ## total ####',
        )
    })

    it('strips zero-width and format characters so they cannot hide a code', () => {
        expect(redactStoreReason(`try save${ZWSP}10 now`, null)).toBe(
            'try [code] now',
        )
        expect(redactStoreReason('try SA⁠VE﻿10 now', null)).toBe(
            'try [code] now',
        )
        expect(stripFormatChars(`a${ZWSP}b‍`)).toBe('ab')
    })

    it('redacts a code in any script, not only ASCII', () => {
        expect(redactStoreReason('Code ÉTÉ20 introuvable', null)).toBe(
            'Code [code] introuvable',
        )
    })

    it('does not mistake caseless scripts for caps words', () => {
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
            hasCodeShapedToken('Minimum spend $50', { contextualCaps: true }),
        ).toBe(false)
        expect(
            hasCodeShapedToken('with MYCODE5', { contextualCaps: true }),
        ).toBe(true)
        expect(
            hasCodeShapedToken('code MYCODE', { contextualCaps: true }),
        ).toBe(true)
        expect(hasCodeShapedToken('code MYCODE')).toBe(false)
    })
})

describe('redactCodeShapedTokens (mixed tokens only, the default)', () => {
    it('leaves shouted words alone: page labels are full of them', () => {
        const text = 'APPLY ORDER SUMMARY NIKE AIR MAX code MYCODE'
        expect(redactCodeShapedTokens(text)).toBe(text)
    })

    it('redacts only the mixed token', () => {
        expect(redactCodeShapedTokens('Remove SAVE10 now')).toBe(
            'Remove [code] now',
        )
    })

    it('leaves what the header says it leaves: 2-character tokens, ordinals, split codes', () => {
        expect(redactCodeShapedTokens('A1 and 1st and 22nd')).toBe(
            'A1 and 1st and 22nd',
        )
        expect(redactCodeShapedTokens('save 10 and save.10')).toBe(
            'save 10 and save.10',
        )
    })
})

describe('scrubCartItems', () => {
    it('drops rows that read like a discount line, in any case', () => {
        expect(
            scrubCartItems([
                'Discount: SAVE10',
                'Blue Widget',
                'COUPON FALL20 applied',
                'Promo applied FALL20',
                'Discount -$5.00',
                'Code applied: X',
                'Voucher: WELCOME',
            ]),
        ).toEqual(['Blue Widget'])
    })

    it('keeps products whose titles merely contain a label word', () => {
        const items = [
            'Promontory hiking boots',
            'Coupon organizer',
            'Savings planner',
            'Gift voucher holder',
            'Discounted Widget',
            'Promotional mug',
            'Savings planner $12.99',
            'Coupon organizer - $8',
            'Total savings $5',
        ]
        expect(scrubCartItems(items)).toEqual(items)
    })

    it('drops a discount row whose label hides behind a zero-width character', () => {
        expect(scrubCartItems([`Dis${ZWSP}count: SAVE10`, 'Widget'])).toEqual([
            'Widget',
        ])
        expect(scrubCartItems([`Discount: save${ZWSP}10`])).toEqual([])
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
