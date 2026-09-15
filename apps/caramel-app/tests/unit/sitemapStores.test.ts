import { collapseStoreRows } from '@/lib/seo/sitemapStores'
import { describe, expect, it } from 'vitest'

// Pins the sitemap's store collapse: raw `GROUP BY site` rows → one canonical
// entry per registrable domain, counts summed, newest timestamp kept, policy
// applied. The fixtures are the real prod shapes from the 2026-09-11 audit
// (caramel-artifact/seo-2026-09-11/audit-findings.md §Sitemap).

const d = (iso: string) => new Date(iso)

describe('collapseStoreRows — subdomain slugs fold into ONE canonical base', () => {
    it('athleta.gap.com + gap.com + bananarepublic.gap.com → one gap.com entry with the summed count and the max last_updated', () => {
        const entries = collapseStoreRows([
            {
                site: 'athleta.gap.com',
                coupon_count: 7,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'gap.com',
                coupon_count: 30,
                last_updated: d('2026-08-15T00:00:00Z'),
            },
            {
                site: 'bananarepublic.gap.com',
                coupon_count: 4,
                last_updated: d('2026-09-10T12:00:00Z'),
            },
        ])
        expect(entries).toEqual([
            {
                base: 'gap.com',
                couponCount: 41,
                lastModified: d('2026-09-10T12:00:00Z'),
            },
        ])
    })

    it('a base that only exists as subdomain rows (roborock.com via us.roborock.com) is emitted under the base', () => {
        const entries = collapseStoreRows([
            {
                site: 'us.roborock.com',
                coupon_count: 16,
                last_updated: d('2026-09-02T00:00:00Z'),
            },
        ])
        expect(entries.map(e => e.base)).toEqual(['roborock.com'])
    })
})

describe('collapseStoreRows — mixed-case slugs fold into their lowercase twin', () => {
    it('Brooklinen.com + brooklinen.com → one brooklinen.com entry', () => {
        const entries = collapseStoreRows([
            {
                site: 'Brooklinen.com',
                coupon_count: 2,
                last_updated: d('2026-07-01T00:00:00Z'),
            },
            {
                site: 'brooklinen.com',
                coupon_count: 9,
                last_updated: d('2026-09-05T00:00:00Z'),
            },
        ])
        expect(entries).toEqual([
            {
                base: 'brooklinen.com',
                couponCount: 11,
                lastModified: d('2026-09-05T00:00:00Z'),
            },
        ])
    })

    it('eNasco.com alone → enasco.com (the page canonicalizes to lowercase, so the sitemap must too)', () => {
        const entries = collapseStoreRows([
            {
                site: 'eNasco.com',
                coupon_count: 3,
                last_updated: d('2026-08-20T00:00:00Z'),
            },
        ])
        expect(entries.map(e => e.base)).toEqual(['enasco.com'])
    })
})

describe('collapseStoreRows — rows that name no store are dropped', () => {
    it('drops dhl.com-us-en-home.html (not a domain), co.uk (bare public suffix), null and empty sites', () => {
        const entries = collapseStoreRows([
            {
                site: 'dhl.com-us-en-home.html',
                coupon_count: 5,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'co.uk',
                coupon_count: 50,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            { site: null, coupon_count: 5, last_updated: null },
            { site: '', coupon_count: 5, last_updated: null },
            {
                site: 'mymemory.co.uk',
                coupon_count: 12,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
        ])
        expect(entries.map(e => e.base)).toEqual(['mymemory.co.uk'])
    })

    it('drops a 0-count row (the page would noindex it)', () => {
        const entries = collapseStoreRows([
            {
                site: 'example.com',
                coupon_count: 0,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'other.example.com',
                coupon_count: 0,
                last_updated: null,
            },
            {
                site: 'kept.com',
                coupon_count: 1,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
        ])
        expect(entries.map(e => e.base)).toEqual(['kept.com'])
    })

    it('a base whose rows sum to ≥1 stays even if one of its slugs is 0', () => {
        const entries = collapseStoreRows([
            { site: 'a.shein.com', coupon_count: 0, last_updated: null },
            {
                site: 'shein.com',
                coupon_count: 1,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
        ])
        expect(entries).toEqual([
            {
                base: 'shein.com',
                couponCount: 1,
                lastModified: d('2026-09-01T00:00:00Z'),
            },
        ])
    })
})

describe('collapseStoreRows — output shape', () => {
    it('is sorted by base and carries a null lastModified when no row had a timestamp', () => {
        const entries = collapseStoreRows([
            { site: 'zeta.com', coupon_count: 1, last_updated: null },
            {
                site: 'alpha.com',
                coupon_count: 2,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            { site: 'mid.com', coupon_count: 3, last_updated: null },
        ])
        expect(entries.map(e => e.base)).toEqual([
            'alpha.com',
            'mid.com',
            'zeta.com',
        ])
        expect(entries[2]!.lastModified).toBeNull()
    })

    it('returns [] for no rows', () => {
        expect(collapseStoreRows([])).toEqual([])
    })
})
