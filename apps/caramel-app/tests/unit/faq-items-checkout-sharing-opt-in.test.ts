import { faqItems } from '@/lib/faqItems'
import { describe, expect, it } from 'vitest'

// Checkout code sharing is OPT-IN (owner rule 2026-10-06, the Honey-lawsuit
// lesson: a privacy-policy sentence is not consent). The extension (1.4.8)
// captures a typed code only after the shopper accepts an in-extension prompt
// or switches "Share codes I enter at checkout" on in its settings; it is OFF
// by default. So the two FAQ answers that cover it must state the same facts as
// the privacy policy AND say it is off by default and turns on only by the
// shopper's own yes: only a code the shopper typed once the store accepts it,
// the store and the account, never cart/order/payment details, shown without
// the name. Patterns, not exact text, so copy edits don't break them.
//
// This file used to ban the word "opt-in" because the setting defaulted ON; it
// now pins the opposite, and bans any wording that implies sharing is on unless
// the shopper turns it off.
const answerFor = (question: string): string => {
    const item = faqItems.find(i => i.question === question)
    if (!item) throw new Error(`FAQ item missing: ${question}`)
    return item.answer
}

const SHARING_QUESTIONS = [
    'Can I share a coupon code with Caramel?',
    'What data does the Caramel extension collect?',
] as const

describe('FAQ checkout-sharing wording', () => {
    it.each(SHARING_QUESTIONS)(
        '"%s" carries the checkout-sharing disclosure',
        question => {
            const answer = answerFor(question)
            expect(answer).toContain('"Share codes I enter at checkout"')
            expect(answer).toMatch(/code you typed yourself/)
            expect(answer).toMatch(/once the store accepts it/)
            expect(answer).toMatch(/never your cart, order or payment details/)
            expect(answer).toMatch(/without your name/)
        },
    )

    it.each(SHARING_QUESTIONS)(
        '"%s" says sharing is OFF by default and needs the shopper to agree',
        question => {
            const answer = answerFor(question)
            expect(answer).toMatch(/off by default/i)
            // Turned on by the in-extension prompt or by the setting.
            expect(answer).toMatch(/prompt/i)
            expect(answer).toMatch(/switch on the extension setting/i)
            // The shopper can still turn it off again.
            expect(answer).toMatch(/turn (the setting|that) off at any time/)
        },
    )

    it('no answer implies sharing is on unless the shopper switches it off', () => {
        for (const { question, answer } of faqItems) {
            expect(answer, question).not.toMatch(
                /on by default|enabled by default|unless you turn (it|that|the setting) off|opt(ing)? out/i,
            )
        }
    })

    it('the share-a-code answer still covers the website Add a code flow', () => {
        const answer = answerFor('Can I share a coupon code with Caramel?')
        expect(answer).toMatch(/sign in/i)
        expect(answer).toMatch(/Add a code/)
        expect(answer).toMatch(/Unverified/)
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
