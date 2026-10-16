import type { StoreCouponFacts } from '@/lib/couponsRepo'
import {
    buildStoreDescription,
    buildStoreTitle,
    storeDisplayName,
} from '@/lib/seo/storeMetadata'
import { describe, expect, it } from 'vitest'

// Render time pinned: the month in a title depends on it.
const NOW = new Date('2026-10-16T20:00:00Z')

function facts(overrides: Partial<StoreCouponFacts> = {}): StoreCouponFacts {
    return {
        percentOffCodes: 18,
        bestPercentOff: 50,
        fixedAmountCodes: 0,
        lastUpdated: new Date('2026-08-04T09:00:00Z'),
        ...overrides,
    }
}

describe('storeDisplayName', () => {
    it('title-cases the label in front of the public suffix', () => {
        expect(storeDisplayName('coursera.org')).toBe('Coursera')
        expect(storeDisplayName('philips-hue.com')).toBe('Philips Hue')
        expect(storeDisplayName('mymemory.co.uk')).toBe('Mymemory')
    })

    it('uses the brand spelling where title case gets it wrong, on any suffix', () => {
        expect(storeDisplayName('eharmony.ca')).toBe('eHarmony')
        expect(storeDisplayName('coursehero.com')).toBe('Course Hero')
        expect(storeDisplayName('dominos.com')).toBe("Domino's")
    })
})

describe('buildStoreTitle', () => {
    it('coursera.org (catalog last updated in August): brand first, the live count, no month, and not "Active"', () => {
        // 73 days without an update: the count is what the page lists, but a
        // headline calling those codes "active" would claim a freshness the
        // catalog cannot show.
        expect(
            buildStoreTitle({
                base: 'coursera.org',
                total: 22,
                facts: facts(),
                uk: false,
                now: NOW,
            }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Codes | Caramel')
    })

    it('says "Active" only for a list updated in the last 30 days', () => {
        const input = { base: 'coursera.org', total: 22, uk: false, now: NOW }
        expect(
            buildStoreTitle({
                ...input,
                facts: facts({
                    lastUpdated: new Date('2026-09-20T00:00:00Z'),
                }),
            }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Active Codes | Caramel')
        expect(
            buildStoreTitle({
                ...input,
                facts: facts({
                    lastUpdated: new Date('2026-09-15T00:00:00Z'),
                }),
            }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Codes | Caramel')
        expect(
            buildStoreTitle({ ...input, facts: facts({ lastUpdated: null }) }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Codes | Caramel')
    })

    it('names the month only when the list was updated this month', () => {
        const input = {
            base: 'coursera.org',
            total: 22,
            uk: false,
            now: NOW,
        }
        expect(
            buildStoreTitle({
                ...input,
                facts: facts({
                    lastUpdated: new Date('2026-10-02T00:00:00Z'),
                }),
            }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Codes, Oct 2026 | Caramel')
        // Two days earlier, but last month: no month at all, rather than a
        // title dated to a month the list was not updated in.
        expect(
            buildStoreTitle({
                ...input,
                facts: facts({
                    lastUpdated: new Date('2026-09-30T23:00:00Z'),
                }),
                now: new Date('2026-10-01T01:00:00Z'),
            }),
        ).toBe('Coursera Promo Codes & Coupons: 22 Active Codes | Caramel')
    })

    it('spells the month out when it fits', () => {
        expect(
            buildStoreTitle({
                base: 'nike.com',
                total: 64,
                facts: facts({
                    lastUpdated: new Date('2026-10-14T00:00:00Z'),
                }),
                uk: false,
                now: NOW,
            }),
        ).toBe('Nike Promo Codes & Coupons: 64 Codes, October 2026 | Caramel')
    })

    it('UK stores speak discount codes and vouchers', () => {
        expect(
            buildStoreTitle({
                base: 'argos.co.uk',
                total: 9,
                facts: facts(),
                uk: true,
                now: NOW,
            }),
        ).toBe('Argos Discount Codes & Vouchers: 9 Codes | Caramel')
    })

    it('a store with no codes gets the generic title, never a count', () => {
        expect(
            buildStoreTitle({
                base: 'preply.com',
                total: 0,
                facts: facts({ bestPercentOff: null, lastUpdated: null }),
                uk: false,
                now: NOW,
            }),
        ).toBe('Preply Coupons & Promo Codes | Caramel')
    })

    it('drops the suffix, then the count, before passing 60 characters', () => {
        const title = buildStoreTitle({
            base: 'countrymusichalloffame.org',
            total: 1,
            facts: facts(),
            uk: false,
            now: NOW,
        })
        expect(title).toBe(
            'Countrymusichalloffame Promo Codes & Coupons: 1 Code',
        )
    })
})

describe('buildStoreDescription', () => {
    it('coursera.org: the searched words, the domain, the best listed discount and what to do', () => {
        const description = buildStoreDescription({
            base: 'coursera.org',
            total: 22,
            facts: facts(),
            uk: false,
            now: NOW,
        })
        expect(description).toBe(
            "22 Coursera promo codes, coupons & discount codes for coursera.org, up to 50% off. Copy a code, or let Caramel's free extension try them at checkout.",
        )
    })

    it('claims no percentage when no listed code states one', () => {
        expect(
            buildStoreDescription({
                base: 'groupon.com',
                total: 40,
                facts: facts({ bestPercentOff: null }),
                uk: false,
                now: NOW,
            }),
        ).not.toContain('% off')
    })
})

describe('every title and description fits the snippet', () => {
    const stores: Array<[string, boolean]> = [
        ['coursera.org', false],
        ['anthropologie.com', false],
        ['prettylittlething.com', false],
        ['mountainwarehouse.com', false],
        ['countrymusichalloffame.org', false],
        ['getthelabel.com', false],
        ['simplybe.co.uk', true],
        // The longest UK store in the live sitemap (2026-10-16).
        ['choicefurnituresuperstore.co.uk', true],
        ['electronicwhiteboardswarehouse.com', false],
        ['countrystorecatalog.com', false],
    ]
    for (const [base, uk] of stores) {
        for (const total of [0, 1, 22, 1176]) {
            it(`${base} with ${total} codes`, () => {
                const input = {
                    base,
                    total,
                    facts: facts({
                        bestPercentOff: 12.5,
                        lastUpdated: new Date('2026-10-01T00:00:00Z'),
                    }),
                    uk,
                    now: NOW,
                }
                expect(buildStoreTitle(input).length).toBeLessThanOrEqual(60)
                expect(buildStoreDescription(input).length).toBeLessThanOrEqual(
                    155,
                )
            })
        }
    }
})
