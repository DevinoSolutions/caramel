// The store page's FAQ, as data. ONE list feeds both the visible questions on
// /coupons/<store> and that page's FAQPage JSON-LD, so the two cannot drift.
//
// Why it exists: Search Console (2026-09-19 to 09-25) has the store pages
// ranking around position 40 for "<store> promo code" queries, and the pages
// that outrank them (CouponFollow, RetailMeNot, Coupert) carry a per-store FAQ
// and per-store numbers. Caramel's page had one generic paragraph.
//
// CLAIM INTEGRITY: every per-store statement comes from the catalog read the
// page already makes (listStoreCoupons: the count, percent-off and
// fixed-amount counts, the best percent-off amount, the newest updated_at)
// or from the top-ranked coupon row the page lists first. Nothing about the
// store itself (shipping, returns, loyalty) is stated: the catalog holds no
// such facts. Fixed amounts get no currency symbol because the catalog has no
// currency column. The extension answers repeat claims already verified for
// the landing FAQ (src/lib/faqItems.ts: browsers, affiliate links, open
// source).
import type { StoreCouponFacts } from '@/lib/couponsRepo'

export type StoreFaqItem = { question: string; answer: string }

export type StoreFaqInput = {
    /** Registrable store domain, as the page's h1 shows it. */
    base: string
    /** Active (visible) codes for the store: the count the title states. */
    total: number
    facts: StoreCouponFacts
    /** Title of the coupon the page lists first (its ranking order). */
    topCouponTitle: string | null
    /** UK store: "discount code" vocabulary and a UK date format. */
    uk: boolean
}

function plural(count: number, one: string, many: string): string {
    return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

function formatPercent(amount: number): string {
    // 12.5 stays 12.5; 20 stays 20 (no "20.0").
    return `${Number(amount.toFixed(1))}%`
}

/** The FAQ for a store page. Empty for a store with no active codes: that
 *  page is noindexed and must not answer questions about codes it lacks. */
export function buildStoreFaq(input: StoreFaqInput): StoreFaqItem[] {
    const { base, total, facts, topCouponTitle, uk } = input
    if (total <= 0) return []

    const noun = uk ? 'discount code' : 'coupon code'
    const nouns = `${noun}s`
    const otherOffers = total - facts.percentOffCodes - facts.fixedAmountCodes

    const items: StoreFaqItem[] = []

    // 1. The best code. The biggest percent-off amount is the one number a
    // shopper can compare across sites; the first-listed title is the row
    // the page ranks first.
    const bestParts: string[] = []
    if (facts.bestPercentOff !== null) {
        bestParts.push(
            `The biggest percent-off discount among the ${plural(total, `active ${base} ${noun}`, `active ${base} ${nouns}`)} Caramel lists is ${formatPercent(facts.bestPercentOff)} off.`,
        )
    } else if (facts.fixedAmountCodes > 0) {
        const fixed = facts.fixedAmountCodes
        bestParts.push(
            `Caramel lists ${plural(total, `active ${base} ${noun}`, `active ${base} ${nouns}`)}, and ${total === 1 ? 'it takes' : `${fixed.toLocaleString('en-US')} of them ${fixed === 1 ? 'takes' : 'take'}`} a fixed amount off rather than a percentage.`,
        )
    } else {
        bestParts.push(
            `Caramel lists ${plural(total, `active ${base} ${noun}`, `active ${base} ${nouns}`)}; none of them states a usable discount amount up front.`,
        )
    }
    if (topCouponTitle) {
        bestParts.push(
            `The one Caramel ranks first is "${topCouponTitle.trim()}".`,
        )
    }
    bestParts.push(
        'Codes can stop working without notice, so the Caramel extension tries them at checkout and keeps the one that gives the biggest discount.',
    )
    items.push({
        question: `What is the best ${base} ${noun} right now?`,
        answer: bestParts.join(' '),
    })

    // 2. How many, broken down by the same rule the coupon cards badge by.
    const breakdown: string[] = []
    if (facts.percentOffCodes > 0) {
        breakdown.push(
            `${plural(facts.percentOffCodes, 'percent-off code', 'percent-off codes')}${facts.bestPercentOff !== null ? ` (up to ${formatPercent(facts.bestPercentOff)} off)` : ''}`,
        )
    }
    if (facts.fixedAmountCodes > 0) {
        breakdown.push(
            plural(
                facts.fixedAmountCodes,
                'fixed-amount code',
                'fixed-amount codes',
            ),
        )
    }
    if (otherOffers > 0 && breakdown.length > 0) {
        breakdown.push(
            // Codes with no amount, and percent-off amounts of 100 or more
            // (a producer error, see couponsRepo.ts percentOffSql).
            plural(otherOffers, 'other offer', 'other offers'),
        )
    }
    const lastPart = breakdown.pop()
    let countAnswer = `Caramel's catalog lists ${plural(total, `active ${noun}`, `active ${nouns}`)} for ${base}`
    if (lastPart === undefined) countAnswer += '.'
    else if (breakdown.length === 0) countAnswer += `: ${lastPart}.`
    else countAnswer += `: ${breakdown.join(', ')} and ${lastPart}.`
    if (facts.lastUpdated) {
        const date = facts.lastUpdated.toLocaleDateString(
            uk ? 'en-GB' : 'en-US',
            { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' },
        )
        countAnswer += ` The list was last updated on ${date}; codes that stop working are retired as they are found.`
    }
    items.push({
        question: `How many ${base} ${nouns} does Caramel have?`,
        answer: countAnswer,
    })

    // 3. How to use one: the copy button on each card, or the extension.
    items.push({
        question: `How do I use a ${base} ${noun}?`,
        answer: `Choose a code on this page and select "Get Coupon Code" to copy it, then paste it into the promo code box at checkout on ${base}. With the free Caramel extension for Chrome, Firefox, Edge or Safari you can skip the copying: at checkout it tries the ${base} codes for you and applies the one with the biggest discount.`,
    })

    // 4. The trust question (claims verified for the landing FAQ).
    items.push({
        question: `Does Caramel change affiliate links when I shop at ${base}?`,
        answer: 'No. The Caramel extension contains no affiliate code: it never adds, replaces or removes affiliate links, so whoever referred you to the store keeps the credit. The extension and the website are open source under the AGPL-3.0 license, so anyone can check this.',
    })

    return items
}
