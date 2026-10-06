/**
 * The store listing (scripts/store-listing.mjs) is public copy every store
 * reviewer and shopper reads, so it is pinned like code:
 *
 *   - store length limits: Chrome Web Store title 75 and short description
 *     132; AMO name 50; Edge name 45 (the Firefox name is the one sized for
 *     both); Edge wants a detailed description of at least 250 characters,
 *   - no claim the extension does not back up (claim audit 2026-10-05): no
 *     "AI" (the only model call is a cart classifier, not a feature), no
 *     cashback / rewards offer, no price history, no "every code" / "best
 *     code" / "every store" promises, no silent auto-apply without the tap.
 */

import { describe, expect, it } from 'vitest'

import {
    DESCRIPTION,
    FIREFOX_NAME,
    NAME,
    SUMMARY,
} from '../scripts/store-listing.mjs'

const ALL = [NAME, FIREFOX_NAME, SUMMARY, DESCRIPTION]

describe('store listing copy', () => {
    it('fits each store limit', () => {
        expect(NAME.length).toBeLessThanOrEqual(75)
        expect(NAME.length).toBeGreaterThanOrEqual(50)
        expect(FIREFOX_NAME.length).toBeLessThanOrEqual(45)
        expect(SUMMARY.length).toBeLessThanOrEqual(132)
        expect(DESCRIPTION.length).toBeGreaterThanOrEqual(250)
        expect(DESCRIPTION.length).toBeLessThanOrEqual(10000)
    })

    it('leads both names with the brand', () => {
        expect(NAME.startsWith('Caramel: ')).toBe(true)
        expect(FIREFOX_NAME.startsWith('Caramel: ')).toBe(true)
    })

    it('never says AI', () => {
        for (const text of ALL) {
            expect(text).not.toMatch(/\bA\.?I\b|artificial intelligence/i)
        }
    })

    it('makes no claim the extension does not back up', () => {
        const banned = [
            /every (coupon|code|store|site)/i,
            /all (coupon|code|store|site)s/i,
            /best (coupon|code)/i,
            /\balways\b/i,
            /guarantee/i,
            /price (history|tracker|comparison|meter)/i,
            /savings meter/i,
            /\baudit/i,
            /earn (cash|rewards|points)/i,
        ]
        for (const text of ALL) {
            for (const pattern of banned) {
                expect(text).not.toMatch(pattern)
            }
        }
        // Cashback and rewards may only appear as what Caramel does NOT do.
        for (const match of DESCRIPTION.matchAll(/cashback|rewards/gi)) {
            const before = DESCRIPTION.slice(
                Math.max(0, match.index - 40),
                match.index,
            )
            expect(before).toMatch(/doesn't offer|no /i)
        }
        expect(SUMMARY).not.toMatch(/cashback|rewards/i)
    })

    it('says the apply step needs the shopper tap', () => {
        expect(DESCRIPTION).toMatch(/\btap\b/i)
        expect(DESCRIPTION).toMatch(/up to 8 codes/)
    })
})
