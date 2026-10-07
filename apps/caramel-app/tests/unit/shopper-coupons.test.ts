import {
    SHOPPER_CODE_PATTERN,
    SHOPPER_COUPON_DESCRIPTION,
    SHOPPER_COUPON_ID_FLOOR,
    SHOPPER_DAILY_SUBMISSION_CAP,
    ShopperSubmissionLimitError,
    looksLikeCardNumber,
    normalizeShopperCode,
} from '@/lib/shopperCoupons'
import { describe, expect, it } from 'vitest'

// The pure layer of shopper-submitted coupon codes. The extension's
// code-capture.js mirrors SHOPPER_CODE_PATTERN (no bundler, so it cannot import
// this file); a later test pins the two patterns as equal.

describe('normalizeShopperCode', () => {
    it('trims surrounding whitespace', () => {
        expect(normalizeShopperCode('  SAVE10 ')).toBe('SAVE10')
    })

    it('never changes case (codes are case-significant to some stores)', () => {
        expect(normalizeShopperCode('save10')).toBe('save10')
        expect(normalizeShopperCode('SaVe10')).toBe('SaVe10')
    })

    it('accepts letters, digits, underscore and hyphen, 3 to 40 characters', () => {
        expect(normalizeShopperCode('A_B-9')).toBe('A_B-9')
        expect(normalizeShopperCode('abc')).toBe('abc')
        expect(normalizeShopperCode('a'.repeat(40))).toBe('a'.repeat(40))
    })

    it.each([
        ['too short', 'ab'],
        ['inner whitespace', 'a b c'],
        ['markup', '<script>'],
        ['41 characters', 'a'.repeat(41)],
        ['empty', ''],
        ['only whitespace', '   '],
        ['leading hyphen', '-SAVE10'],
        ['leading underscore', '_SAVE10'],
        ['non-ASCII letters', 'SÄVE10'],
    ])('rejects %s', (_label, raw) => {
        expect(normalizeShopperCode(raw)).toBeNull()
    })

    // Gift-card / card numbers typed into a look-alike promo box must never be
    // stored (and published on a store page).
    it.each([
        ['an 8-digit number', '12345678'],
        ['a 16-digit card number', '4111111111111111'],
        ['a hyphenated 16-digit card number', '4111-1111-1111-1111'],
        ['a 16+ character string with 12 digits', 'AB12-3456-7890-1234'],
    ])('rejects %s as card-shaped', (_label, raw) => {
        expect(normalizeShopperCode(raw)).toBeNull()
    })

    it.each([
        ['7 digits', '1234567'],
        ['a normal code with digits', 'SAVE2024'],
        ['a 16-character code with 11 digits', 'ABCDE-12345678901'],
        ['a long word code', 'SUMMERSALEFOREVERYONE'],
    ])('still accepts %s', (_label, raw) => {
        expect(normalizeShopperCode(raw)).toBe(raw)
    })
})

describe('looksLikeCardNumber', () => {
    it('flags all-digit strings of 8 or more', () => {
        expect(looksLikeCardNumber('1234567')).toBe(false)
        expect(looksLikeCardNumber('12345678')).toBe(true)
    })

    it('flags 16+ characters holding 12+ digits, not 11', () => {
        expect(looksLikeCardNumber('ABCD-123456789012')).toBe(true)
        expect(looksLikeCardNumber('ABCDE-12345678901')).toBe(false)
        expect(looksLikeCardNumber('A1-23456789012')).toBe(false) // 14 long
    })
})

describe('shopper coupon constants', () => {
    it('reserves ids from 900000000000000000 up', () => {
        expect(SHOPPER_COUPON_ID_FLOOR).toBe(BigInt('900000000000000000'))
    })

    it('caps a shopper at 20 submissions per 24 hours', () => {
        expect(SHOPPER_DAILY_SUBMISSION_CAP).toBe(20)
    })

    it('exposes the code pattern normalizeShopperCode enforces', () => {
        expect(SHOPPER_CODE_PATTERN.source).toBe(
            '^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$',
        )
    })

    it('states the description every shopper row carries', () => {
        expect(SHOPPER_COUPON_DESCRIPTION).toBe('Shared by a Caramel shopper.')
    })
})

describe('ShopperSubmissionLimitError', () => {
    it('is a named Error that carries the cap and no user identity', () => {
        const error = new ShopperSubmissionLimitError()
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe('ShopperSubmissionLimitError')
        expect(error.cap).toBe(SHOPPER_DAILY_SUBMISSION_CAP)
        expect(error.message).toContain('20')
    })
})
