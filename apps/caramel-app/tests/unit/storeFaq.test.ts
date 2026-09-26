import type { StoreCouponFacts } from '@/lib/couponsRepo'
import { faqPageJsonLd } from '@/lib/jsonLd'
import { buildStoreFaq } from '@/lib/seo/storeFaq'
import { describe, expect, it } from 'vitest'

// The store page's FAQ (src/lib/seo/storeFaq.ts) states per-store numbers
// in public copy that answer engines quote, so each number must be the
// catalog's and every branch must stay truthful when a fact is missing.

const facts = (over: Partial<StoreCouponFacts> = {}): StoreCouponFacts => ({
    percentOffCodes: 12,
    bestPercentOff: 20,
    fixedAmountCodes: 3,
    lastUpdated: new Date('2026-09-24T23:30:00Z'),
    ...over,
})

const answerTo = (items: { question: string; answer: string }[], q: RegExp) =>
    items.find(item => q.test(item.question))?.answer ?? ''

describe('buildStoreFaq', () => {
    it('states the catalog numbers: best percent off, the breakdown, the update date', () => {
        const items = buildStoreFaq({
            base: 'tradeinn.com',
            total: 17,
            facts: facts(),
            topCouponTitle: '15% Off Your Cart ',
            uk: false,
        })

        expect(items.map(item => item.question)).toEqual([
            'What is the best tradeinn.com coupon code right now?',
            'How many tradeinn.com coupon codes does Caramel have?',
            'How do I use a tradeinn.com coupon code?',
            'Does Caramel change affiliate links when I shop at tradeinn.com?',
        ])
        expect(answerTo(items, /best/)).toContain(
            'The biggest percent-off discount among the 17 active tradeinn.com coupon codes Caramel lists is 20% off.',
        )
        expect(answerTo(items, /best/)).toContain(
            'The one Caramel ranks first is "15% Off Your Cart".',
        )
        // 17 - 12 - 3 = 2 other offers.
        expect(answerTo(items, /How many/)).toBe(
            "Caramel's catalog lists 17 active coupon codes for tradeinn.com: 12 percent-off codes (up to 20% off), 3 fixed-amount codes and 2 other offers. The list was last updated on September 24, 2026; codes that stop working are retired as they are found.",
        )
    })

    it('uses UK vocabulary and a UK date for UK stores, with the date in UTC', () => {
        const items = buildStoreFaq({
            base: 'argos.co.uk',
            total: 1,
            facts: facts({
                percentOffCodes: 1,
                bestPercentOff: 12.5,
                fixedAmountCodes: 0,
                lastUpdated: new Date('2026-09-24T23:30:00Z'),
            }),
            topCouponTitle: null,
            uk: true,
        })
        expect(items[0]?.question).toBe(
            'What is the best argos.co.uk discount code right now?',
        )
        expect(answerTo(items, /best/)).toContain(
            'among the 1 active argos.co.uk discount code Caramel lists is 12.5% off.',
        )
        expect(answerTo(items, /How many/)).toContain(
            'lists 1 active discount code for argos.co.uk: 1 percent-off code (up to 12.5% off).',
        )
        expect(answerTo(items, /How many/)).toContain(
            'last updated on 24 September 2026',
        )
    })

    it('never names a percentage when the store has none, and gives no currency for fixed amounts', () => {
        const items = buildStoreFaq({
            base: 'example.com',
            total: 4,
            facts: facts({
                percentOffCodes: 0,
                bestPercentOff: null,
                fixedAmountCodes: 4,
            }),
            topCouponTitle: null,
            uk: false,
        })
        const best = answerTo(items, /best/)
        expect(best).toContain(
            'Caramel lists 4 active example.com coupon codes, and 4 of them take a fixed amount off rather than a percentage.',
        )
        expect(best).not.toMatch(/%|\$|£|€/)
        expect(answerTo(items, /How many/)).toContain(': 4 fixed-amount codes.')
    })

    it('says no amount is stated when no code has one, and omits the date when there is none', () => {
        const items = buildStoreFaq({
            base: 'example.com',
            total: 2,
            facts: facts({
                percentOffCodes: 0,
                bestPercentOff: null,
                fixedAmountCodes: 0,
                lastUpdated: null,
            }),
            topCouponTitle: null,
            uk: false,
        })
        expect(answerTo(items, /best/)).toContain(
            'none of them states a usable discount amount up front.',
        )
        expect(answerTo(items, /How many/)).toBe(
            "Caramel's catalog lists 2 active coupon codes for example.com.",
        )
    })

    it('is empty for a store with no active codes (that page is noindexed)', () => {
        expect(
            buildStoreFaq({
                base: 'example.com',
                total: 0,
                facts: facts(),
                topCouponTitle: null,
                uk: false,
            }),
        ).toEqual([])
    })
})

describe('faqPageJsonLd', () => {
    it('marks up exactly the rendered questions and answers', () => {
        const items = buildStoreFaq({
            base: 'tradeinn.com',
            total: 17,
            facts: facts(),
            topCouponTitle: null,
            uk: false,
        })
        const jsonLd = faqPageJsonLd(items)
        expect(jsonLd['@type']).toBe('FAQPage')
        expect(
            jsonLd.mainEntity.map(q => [q.name, q.acceptedAnswer.text]),
        ).toEqual(items.map(item => [item.question, item.answer]))
    })
})
