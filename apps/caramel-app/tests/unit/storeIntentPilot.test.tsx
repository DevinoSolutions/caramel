import StoreIntentPilotNote from '@/components/coupons/store-intent-pilot-note'
import type { StoreCouponFacts } from '@/lib/couponsRepo'
import {
    STORE_INTENT_PILOT,
    buildStoreFreshnessLine,
    storeIntentPilotFor,
} from '@/lib/seo/storeIntentPilot'
import { buildStoreDescription, buildStoreTitle } from '@/lib/seo/storeMetadata'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// T-7856 pilot: four stores only. Render time pinned: "today"/"yesterday"
// and the month in a title depend on it.
const NOW = new Date('2026-10-24T15:00:00Z')

function facts(overrides: Partial<StoreCouponFacts> = {}): StoreCouponFacts {
    return {
        percentOffCodes: 18,
        bestPercentOff: 50,
        fixedAmountCodes: 0,
        lastUpdated: new Date('2026-08-04T09:00:00Z'),
        ...overrides,
    }
}

describe('the pilot map', () => {
    it('covers exactly the four T-7856 stores', () => {
        expect(Object.keys(STORE_INTENT_PILOT).sort()).toEqual([
            'anthropologie.com',
            'coursehero.com',
            'coursera.org',
            'dominos.com',
        ])
    })

    it('returns null for every other store, including prototype names', () => {
        expect(storeIntentPilotFor('nike.com')).toBeNull()
        expect(storeIntentPilotFor('www.coursera.org')).toBeNull()
        expect(storeIntentPilotFor('constructor')).toBeNull()
        expect(storeIntentPilotFor('')).toBeNull()
    })

    it('Coursera and Course Hero point at each other, in both directions', () => {
        expect(storeIntentPilotFor('coursera.org')?.confusedWith).toEqual({
            domain: 'coursehero.com',
            name: 'Course Hero',
        })
        expect(storeIntentPilotFor('coursehero.com')?.confusedWith).toEqual({
            domain: 'coursera.org',
            name: 'Coursera',
        })
        expect(
            storeIntentPilotFor('anthropologie.com')?.confusedWith,
        ).toBeUndefined()
        expect(storeIntentPilotFor('dominos.com')?.confusedWith).toBeUndefined()
    })

    it('no pilot H1 claims "today" or "verified": nothing on the page is verified today', () => {
        for (const entry of Object.values(STORE_INTENT_PILOT)) {
            expect(entry.h1).toBeDefined()
            expect(entry.h1?.toLowerCase()).not.toContain('today')
            expect(entry.h1?.toLowerCase()).not.toContain('verified')
        }
    })
})

describe('pilot titles and descriptions', () => {
    const pilotCases: Array<{
        base: string
        total: number
        lastUpdated: Date
        title: string
    }> = [
        {
            base: 'dominos.com',
            total: 81,
            lastUpdated: new Date('2026-10-24T09:00:00Z'),
            title: "Domino's Coupons & Promo Codes: 81 Codes, Oct 2026 | Caramel",
        },
        {
            base: 'anthropologie.com',
            total: 26,
            lastUpdated: new Date('2026-08-15T09:00:00Z'),
            title: 'Anthropologie Promo Codes & Coupon Codes: 26 Codes | Caramel',
        },
        {
            base: 'coursera.org',
            total: 20,
            lastUpdated: new Date('2026-08-04T09:00:00Z'),
            title: 'Coursera Promo Codes & Coupons: 20 Codes | Caramel',
        },
        {
            base: 'coursehero.com',
            total: 3,
            lastUpdated: new Date('2026-07-24T09:00:00Z'),
            title: 'Course Hero Promo Codes & Coupons: 3 Codes | Caramel',
        },
    ]

    it.each(pilotCases)(
        '$base: exact title, within 60 characters',
        ({ base, total, lastUpdated, title }) => {
            const built = buildStoreTitle({
                base,
                total,
                facts: facts({ lastUpdated }),
                uk: false,
                now: NOW,
            })
            expect(built).toBe(title)
            expect(built.length).toBeLessThanOrEqual(60)
        },
    )

    it('every pilot title stays within 60 characters at every count and date', () => {
        for (const base of Object.keys(STORE_INTENT_PILOT)) {
            for (const total of [0, 1, 22, 1176]) {
                for (const lastUpdated of [
                    null,
                    new Date('2026-10-02T00:00:00Z'),
                    new Date('2026-10-20T00:00:00Z'),
                    new Date('2026-08-01T00:00:00Z'),
                ]) {
                    const title = buildStoreTitle({
                        base,
                        total,
                        facts: facts({ lastUpdated }),
                        uk: false,
                        now: NOW,
                    })
                    expect(title.length).toBeLessThanOrEqual(60)
                }
            }
        }
    })

    it('the Coursera description says it is the online-course platform and states only catalog numbers', () => {
        const description = buildStoreDescription({
            base: 'coursera.org',
            total: 20,
            facts: facts(),
            uk: false,
            now: NOW,
        })
        expect(description).toBe(
            "Coursera, the online-course platform: 20 promo codes & coupons, up to 50% off. Copy a code, or let Caramel's free extension try them at checkout.",
        )
        expect(description.length).toBeLessThanOrEqual(155)
    })

    it('the Coursera description claims no percentage when no code states one', () => {
        expect(
            buildStoreDescription({
                base: 'coursera.org',
                total: 20,
                facts: facts({ bestPercentOff: null }),
                uk: false,
                now: NOW,
            }),
        ).not.toContain('% off')
    })

    it('pilot stores without a descriptor keep the default description', () => {
        expect(
            buildStoreDescription({
                base: 'dominos.com',
                total: 81,
                facts: facts({ bestPercentOff: 70 }),
                uk: false,
                now: NOW,
            }),
        ).toBe(
            "81 Domino's promo codes, coupons & discount codes for dominos.com, up to 70% off. Copy a code, or let Caramel's free extension try them at checkout.",
        )
    })

    it('a non-pilot store is unchanged', () => {
        const input = {
            base: 'nike.com',
            total: 64,
            facts: facts({ lastUpdated: new Date('2026-10-14T00:00:00Z') }),
            uk: false,
            now: NOW,
        }
        expect(buildStoreTitle(input)).toBe(
            'Nike Promo Codes & Coupons: 64 Codes, October 2026 | Caramel',
        )
        expect(buildStoreDescription(input)).toBe(
            "64 Nike promo codes, coupons & discount codes for nike.com, up to 50% off. Copy a code, or let Caramel's free extension try them at checkout.",
        )
    })
})

describe('buildStoreFreshnessLine', () => {
    const base = { total: 20, workedInWindow: 3, now: NOW }

    it('says "today" for an update on the same UTC day', () => {
        const line = buildStoreFreshnessLine({
            ...base,
            lastUpdated: new Date('2026-10-24T00:00:01Z'),
        })
        expect(line.updated?.label).toBe('today')
        expect(line.updated?.dateTime).toBe('2026-10-24T00:00:01.000Z')
    })

    it('says "yesterday" for the previous UTC day, even minutes earlier', () => {
        expect(
            buildStoreFreshnessLine({
                ...base,
                now: new Date('2026-10-24T00:30:00Z'),
                lastUpdated: new Date('2026-10-23T23:59:00Z'),
            }).updated?.label,
        ).toBe('yesterday')
    })

    it('prints the date for anything older', () => {
        expect(
            buildStoreFreshnessLine({
                ...base,
                lastUpdated: new Date('2026-08-04T09:00:00Z'),
            }).updated?.label,
        ).toBe('Aug 4, 2026')
        expect(
            buildStoreFreshnessLine({
                ...base,
                lastUpdated: new Date('2026-10-22T23:59:00Z'),
            }).updated?.label,
        ).toBe('Oct 22, 2026')
    })

    it('omits the date when the catalog has none', () => {
        expect(
            buildStoreFreshnessLine({ ...base, lastUpdated: null }).updated,
        ).toBeNull()
    })

    it('counts the worked clause, and omits it at zero', () => {
        const lastUpdated = new Date('2026-08-04T09:00:00Z')
        expect(buildStoreFreshnessLine({ ...base, lastUpdated }).worked).toBe(
            '3 worked in the last 7 days',
        )
        expect(
            buildStoreFreshnessLine({ ...base, lastUpdated, workedInWindow: 0 })
                .worked,
        ).toBeNull()
    })

    it('pluralises the code count', () => {
        expect(
            buildStoreFreshnessLine({ ...base, total: 1, lastUpdated: null })
                .codes,
        ).toBe('1 code')
        expect(
            buildStoreFreshnessLine({ ...base, total: 1176, lastUpdated: null })
                .codes,
        ).toBe('1,176 codes')
    })
})

describe('StoreIntentPilotNote', () => {
    const render = (store: string, workedInWindow = 3) =>
        renderToStaticMarkup(
            <StoreIntentPilotNote
                line={buildStoreFreshnessLine({
                    total: 20,
                    lastUpdated: new Date('2026-08-04T09:00:00Z'),
                    workedInWindow,
                    now: NOW,
                })}
                confusedWith={storeIntentPilotFor(store)?.confusedWith}
            />,
        )

    it('renders the full line with a <time> element', () => {
        expect(render('dominos.com')).toContain(
            '20 codes · list updated <time dateTime="2026-08-04T09:00:00.000Z">Aug 4, 2026</time> · 3 worked in the last 7 days',
        )
    })

    it('drops the worked clause at zero, and never says "verified"', () => {
        expect(render('dominos.com', 0)).not.toContain('worked')
        for (const store of Object.keys(STORE_INTENT_PILOT)) {
            expect(render(store).toLowerCase()).not.toContain('verified')
        }
    })

    it('the Coursera page links to Course Hero, with the disclaimer', () => {
        const html = render('coursera.org')
        expect(html).toContain(
            'Looking for Course Hero? Course Hero (coursehero.com) is a different site — see ',
        )
        expect(html).toContain('href="/coupons/coursehero.com"')
        expect(html).toContain('Course Hero codes →')
    })

    it('the Course Hero page links back to Coursera', () => {
        const html = render('coursehero.com')
        expect(html).toContain('href="/coupons/coursera.org"')
        expect(html).toContain('Looking for Coursera?')
    })

    it("Anthropologie and Domino's carry no cross-link", () => {
        for (const store of ['anthropologie.com', 'dominos.com']) {
            expect(render(store)).not.toContain('Looking for')
        }
    })
})
