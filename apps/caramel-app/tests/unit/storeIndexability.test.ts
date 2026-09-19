import { evaluateStorePageIndexability } from '@/lib/seo/storeIndexability'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { describe, expect, it } from 'vitest'

// Pins THE store-page indexability policy — the single function the sitemap
// (via sitemapStores.ts) and the page's generateMetadata both consult. Cases
// are the real prod shapes from the 2026-09-11 GSC audit
// (caramel-artifact/seo-2026-09-11/audit-findings.md §Sitemap), fed through
// the real resolveStoreDomain so the test proves the whole slug→verdict path.

describe('evaluateStorePageIndexability — a real store with ≥1 visible coupon is indexable', () => {
    it.each([
        ['gap.com', 41],
        ['roborock.com', 16],
        ['pandora.net', 58],
        ['enasco.com', 3],
    ])('%s with %d coupons → indexable, reason null', (base, count) => {
        expect(
            evaluateStorePageIndexability({ base, visibleCouponCount: count }),
        ).toEqual({ indexable: true, reason: null })
    })

    it('exactly ONE coupon is enough (a single live code is still a real answer)', () => {
        expect(
            evaluateStorePageIndexability({
                base: 'kickscrew.com',
                visibleCouponCount: 1,
            }),
        ).toEqual({ indexable: true, reason: null })
    })
})

describe('evaluateStorePageIndexability — zero visible coupons → no-coupons', () => {
    it.each([0, -1, Number.NaN])(
        'count %s → not indexable, reason no-coupons',
        count => {
            expect(
                evaluateStorePageIndexability({
                    base: 'example.com',
                    visibleCouponCount: count,
                }),
            ).toEqual({ indexable: false, reason: 'no-coupons' })
        },
    )
})

describe('evaluateStorePageIndexability — a slug that names no store → not-a-store', () => {
    it.each([null, undefined, '', '   '])(
        'base %s → not indexable, reason not-a-store (even with coupons)',
        base => {
            expect(
                evaluateStorePageIndexability({
                    base,
                    visibleCouponCount: 50,
                }),
            ).toEqual({ indexable: false, reason: 'not-a-store' })
        },
    )

    it.each([
        // The one non-domain slug the served sitemap carried.
        'dhl.com-us-en-home.html',
        // Bare public suffixes — the 2026-08-05 "co.uk store" incident.
        'co.uk',
        'com.au',
        // Reserved / unregistrable TLD (the e2e soft-404 probe slug).
        'no-coupons-here-zz.example',
    ])(
        'resolveStoreDomain(%s) is null, so the policy says not-a-store',
        slug => {
            const base = resolveStoreDomain(slug)
            expect(base).toBeNull()
            expect(
                evaluateStorePageIndexability({
                    base,
                    visibleCouponCount: 12,
                }),
            ).toEqual({ indexable: false, reason: 'not-a-store' })
        },
    )
})

describe('evaluateStorePageIndexability — the canonical base is what gets judged, never the raw slug', () => {
    it.each([
        ['athleta.gap.com', 'gap.com'],
        ['au.shein.com', 'shein.com'],
        ['Brooklinen.com', 'brooklinen.com'],
        ['eNasco.com', 'enasco.com'],
        ['www.codecademy.com', 'codecademy.com'],
    ])('%s resolves to %s and that base is indexable', (slug, expected) => {
        const base = resolveStoreDomain(slug)
        expect(base).toBe(expected)
        expect(
            evaluateStorePageIndexability({ base, visibleCouponCount: 2 })
                .indexable,
        ).toBe(true)
    })
})
