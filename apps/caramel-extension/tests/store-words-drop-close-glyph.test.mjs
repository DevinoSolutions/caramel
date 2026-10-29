import { describe, expect, it } from 'vitest'
import { caramelStoreWords } from '../coupon-runner.js'

// SFRA's "NOT APPLIED" coupon row ends with its remove button, so the quote on
// the final card read “CHEERS25 NOT APPLIED ×” (aquasana.com, 1.4.26).
describe('caramelStoreWords', () => {
    it('drops a trailing close glyph', () => {
        expect(caramelStoreWords('CHEERS25 NOT APPLIED ×')).toBe(
            'CHEERS25 NOT APPLIED',
        )
        expect(caramelStoreWords('Code invalid ✕\n')).toBe('Code invalid')
        expect(caramelStoreWords('Code invalid ✖ ×')).toBe('Code invalid')
    })

    it('keeps the words themselves, including a trailing x letter', () => {
        expect(
            caramelStoreWords('Enter a valid discount code or gift card'),
        ).toBe('Enter a valid discount code or gift card')
        expect(caramelStoreWords('Code not valid on ProMax')).toBe(
            'Code not valid on ProMax',
        )
        expect(caramelStoreWords('Limit 1 × per order applies')).toBe(
            'Limit 1 × per order applies',
        )
    })
})
