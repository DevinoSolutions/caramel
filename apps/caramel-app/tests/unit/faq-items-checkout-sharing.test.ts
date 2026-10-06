import { faqItems } from '@/lib/faqItems'
import { describe, expect, it } from 'vitest'

// Checkout code sharing is live (owner approved the privacy-policy sentence
// 2026-10-06; prod sets SHOPPER_CODE_CAPTURE_ENABLED=true after deploy), so the
// two FAQ answers that cover it must state the same facts as the policy:
// controlled by the extension setting "Share codes I enter at checkout", only
// a code the shopper typed once the store accepts it, the store and the
// account, never cart/order/payment details, and shown without the name.
// Patterns, not exact text, so copy edits don't break them. NOTE the setting
// DEFAULTS ON (caramelNormalizeSettings), so no answer may call it "opt-in".
const answerFor = (question: string): string => {
    const item = faqItems.find(i => i.question === question)
    if (!item) throw new Error(`FAQ item missing: ${question}`)
    return item.answer
}

describe('FAQ checkout-sharing wording', () => {
    it.each([
        'Can I share a coupon code with Caramel?',
        'What data does the Caramel extension collect?',
    ])('"%s" carries the checkout-sharing disclosure', question => {
        const answer = answerFor(question)
        expect(answer).toContain('"Share codes I enter at checkout"')
        expect(answer).toMatch(/code you typed yourself/)
        expect(answer).toMatch(/once the store accepts it/)
        expect(answer).toMatch(/never your cart, order or payment details/)
        expect(answer).toMatch(/without your name/)
    })

    it('the share-a-code answer still covers the website Add a code flow', () => {
        const answer = answerFor('Can I share a coupon code with Caramel?')
        expect(answer).toMatch(/sign in/i)
        expect(answer).toMatch(/Add a code/)
        expect(answer).toMatch(/Unverified/)
    })

    it('no answer calls checkout sharing opt-in (the setting defaults on)', () => {
        for (const { question, answer } of faqItems) {
            expect(answer, question).not.toMatch(/opt-in|opt in|opted in/i)
        }
    })

    it('the data answer keeps its original disclosures', () => {
        const answer = answerFor(
            'What data does the Caramel extension collect?',
        )
        expect(answer).toContain(
            'so rankings stay accurate for everyone. If you',
        )
        expect(answer).toContain(
            'Your settings and optional sign-in are kept in your browser',
        )
    })
})
