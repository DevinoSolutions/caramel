import { faqItems } from '@/lib/faqItems'
import { describe, expect, it } from 'vitest'

// The public FAQ must describe only what is live in production. Checkout code
// capture is OFF in prod (SHOPPER_CODE_CAPTURE_ENABLED=false) until the owner
// approves the privacy-policy sentence, and the extension's "Share codes I
// enter at checkout" setting ships with a later extension release, so no FAQ
// answer may mention it yet. When the flag flips on, update this test together
// with the answers (see the TODO above the item in faqItems.ts and DESIGN.md
// §2(l′)).
describe('FAQ describes only live behaviour (checkout sharing deferred)', () => {
    it('no answer mentions checkout code sharing', () => {
        for (const { question, answer } of faqItems) {
            expect(answer, question).not.toMatch(
                /share codes i enter at checkout|checkout.{0,40}share|share.{0,40}at checkout/i,
            )
        }
    })

    it('the share-a-code answer covers only the website flow', () => {
        const item = faqItems.find(
            i => i.question === 'Can I share a coupon code with Caramel?',
        )
        expect(item?.answer).toBe(
            "Yes. Sign in, open the store's page on Caramel and use Add a code — it shows to other shoppers as Unverified until someone reports it worked. Only the code and the store are shared, along with your account so we can limit abuse.",
        )
    })

    it('the data answer is unchanged from before shopper submissions', () => {
        const item = faqItems.find(
            i => i.question === 'What data does the Caramel extension collect?',
        )
        expect(item?.answer).toContain(
            'so rankings stay accurate for everyone. Your settings and optional sign-in are kept in your browser',
        )
    })
})
