import { describe, expect, it } from 'vitest'
import { caramelQuoteAround, GENERIC_ERROR_TEXT_RE } from '../coupon-apply.js'

/**
 * The store's refusal, as the shopper is shown it and as a report saves it
 * (coupon_signals.last_fail_reason). Prod held quotes like "ly The promotional
 * code you entered is not valid." and "oupon Apply The coupon code entered is
 * not valid for this course.": a fixed 40-before / 120-after slice that
 * started inside a word.
 */
const quote = text =>
    caramelQuoteAround(text, Math.max(0, text.search(GENERIC_ERROR_TEXT_RE)))

describe('the refusal quote', () => {
    it('keeps to the refusal line, leaving the label and button above out', () => {
        expect(
            quote(
                'Promo code\nApply\nThe promotional code you entered is not valid.',
            ),
        ).toBe('The promotional code you entered is not valid.')
    })

    it('never starts inside a word on a one-line box', () => {
        const text =
            'Have a coupon? Enter it below. Coupon Apply The coupon code entered is not valid for this course.'
        const said = quote(text)
        expect(said.endsWith('is not valid for this course.')).toBe(true)
        const at = text.indexOf(said)
        expect(at).toBeGreaterThan(0)
        expect(text[at - 1]).toMatch(/\s/)
    })

    it('never ends inside a word when the store says a lot', () => {
        const text = `This promo code is not valid. ${'Please check the spelling and the dates of your offer. '.repeat(5)}`
        const said = quote(text)
        expect(said.length).toBeLessThanOrEqual(160)
        const end = text.indexOf(said) + said.length
        expect(end === text.length || /\s/.test(text[end])).toBe(true)
    })

    it('a short refusal comes through whole', () => {
        expect(quote('Invalid discount code')).toBe('Invalid discount code')
        expect(quote('  Code expired.  ')).toBe('Code expired.')
    })

    it('a refusal mid-line after a long run keeps its words whole', () => {
        const text = `${'x'.repeat(60)} Sorry, discount SONY is not valid`
        expect(quote(text)).toBe('Sorry, discount SONY is not valid')
    })
})
