import type { Coupon } from '@/types/coupon'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Explicit test doubles at the catalog boundary: no live DB or cache reads.
const catalog = vi.hoisted(() => ({
    listCoupons: vi.fn(),
    listTopSites: vi.fn(),
    attachSignals: vi.fn(),
    getStoreDirectoryEntries: vi.fn(),
}))

vi.mock('@/lib/couponsRepo', () => ({
    listCoupons: catalog.listCoupons,
    listTopSites: catalog.listTopSites,
}))
vi.mock('@/lib/couponSignals', () => ({
    attachSignals: catalog.attachSignals,
}))
vi.mock('@/lib/seo/storeDirectoryCache', () => ({
    getStoreDirectoryEntries: catalog.getStoreDirectoryEntries,
}))

import { guidePageBuilders } from '@/lib/seo/markdownTwins/guidePages'

function coupon(overrides: Partial<Coupon> = {}): Coupon {
    return {
        id: 'fixture-1',
        code: 'FIRST10',
        site: 'example.com',
        title: 'Fixture first coupon',
        description: 'Fixture offer',
        rating: 0,
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
        expiry: null,
        expired: false,
        timesUsed: 0,
        ...overrides,
    }
}

describe('guide Markdown catalog parity', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        catalog.listCoupons.mockResolvedValue({ coupons: [], total: 0 })
        catalog.attachSignals.mockResolvedValue([])
        catalog.listTopSites.mockResolvedValue([])
        catalog.getStoreDirectoryEntries.mockResolvedValue([])
    })

    it('reads the same first page once and keeps the unscoped HTML list, deduplicating by id', async () => {
        const first = coupon()
        const duplicate = coupon({ code: 'DUPLICATE', title: 'Duplicate row' })
        const failing = coupon({
            id: 'fixture-2',
            code: 'STILLPUBLIC',
            keepsFailing: true,
        })
        const coupons = [first, duplicate, failing]
        catalog.listCoupons.mockResolvedValue({ coupons, total: 50 })
        catalog.attachSignals.mockResolvedValue(coupons)
        catalog.listTopSites.mockResolvedValue([
            { site: null, coupon_count: 4 },
            { site: 'example.com', coupon_count: 3 },
        ])

        const page = await guidePageBuilders['/coupons']()

        expect(catalog.listCoupons).toHaveBeenCalledExactlyOnceWith({
            limit: 5,
            skip: 0,
        })
        expect(catalog.attachSignals).toHaveBeenCalledExactlyOnceWith(coupons)
        expect(catalog.listTopSites).toHaveBeenCalledTimes(1)
        expect(catalog.getStoreDirectoryEntries).toHaveBeenCalledTimes(1)
        expect(page.body.match(/Code: `FIRST10`/g)).toHaveLength(1)
        expect(page.body).toContain('Code: `STILLPUBLIC`')
        expect(page.body).not.toContain('DUPLICATE')
        expect(page.body).toContain(
            'https://grabcaramel.com/coupons/example.com',
        )
        expect(page.body).not.toContain('https://grabcaramel.com/coupons/null')
        expect(page.body).not.toContain("You've seen all available coupons.")
    })

    it('uses one shared cached directory read and links only nonempty letter buckets', async () => {
        catalog.getStoreDirectoryEntries.mockResolvedValue([
            { base: 'alpha.com', couponCount: 2, lastModified: null },
            { base: 'another.com', couponCount: 3, lastModified: null },
            { base: 'beta.com', couponCount: 1, lastModified: null },
        ])

        const page = await guidePageBuilders['/coupons/stores']()

        expect(catalog.getStoreDirectoryEntries).toHaveBeenCalledTimes(1)
        expect(catalog.listCoupons).not.toHaveBeenCalled()
        expect(page.summary).toContain('3 stores')
        expect(page.body).toContain(
            '[A](https://grabcaramel.com/coupons/stores/a) — 2 stores',
        )
        expect(page.body).toContain(
            '[B](https://grabcaramel.com/coupons/stores/b) — 1 store',
        )
        expect(page.body).not.toContain(
            'https://grabcaramel.com/coupons/stores/c',
        )
    })

    it('preserves the empty catalog states without advertising nonexistent stores', async () => {
        const hub = await guidePageBuilders['/coupons']()
        const directory = await guidePageBuilders['/coupons/stores']()

        expect(hub.body).toContain('No coupons found')
        expect(hub.body).not.toContain('Popular coupon stores')
        expect(hub.body).not.toContain('Browse stores A–Z')
        expect(directory.summary).toContain('no stores with live coupon codes')
        expect(directory.body).toBe('')
    })
})
