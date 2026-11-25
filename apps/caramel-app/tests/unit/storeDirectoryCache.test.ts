import {
    STORE_DIRECTORY_TTL_MS,
    getStoreDirectoryEntries,
    resetStoreDirectoryCache,
} from '@/lib/seo/storeDirectoryCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins src/lib/seo/storeDirectoryCache.ts: ONE sitemap-identical read
// (listStoreSitemapEntries under the shared 5000 cap → collapseStoreRows)
// cached per process for 5 minutes, in-flight de-duplicated, stale-on-error.
// The repo boundary is mocked so no SQL runs; the collapse is the real one.

const { repoMock } = vi.hoisted(() => ({
    repoMock: { listStoreSitemapEntries: vi.fn() },
}))
vi.mock('@/lib/couponsRepo', () => repoMock)

const d = (iso: string) => new Date(iso)
const ROWS = [
    { site: 'athleta.gap.com', coupon_count: 7, last_updated: d('2026-09-01') },
    { site: 'gap.com', coupon_count: 30, last_updated: d('2026-08-15') },
    { site: 'co.uk', coupon_count: 50, last_updated: d('2026-09-01') },
]

beforeEach(() => {
    resetStoreDirectoryCache()
    repoMock.listStoreSitemapEntries.mockReset()
    repoMock.listStoreSitemapEntries.mockResolvedValue(ROWS)
})

describe('getStoreDirectoryEntries', () => {
    it('reads the sitemap window (5000 grouped rows) and returns the collapsed, policy-gated, base-sorted entries', async () => {
        const entries = await getStoreDirectoryEntries()
        expect(repoMock.listStoreSitemapEntries).toHaveBeenCalledWith(5000)
        expect(entries).toEqual([
            { base: 'gap.com', couponCount: 37, lastModified: d('2026-09-01') },
        ])
    })

    it('serves from memory within the TTL and rebuilds once it has expired', async () => {
        const t0 = 1_000_000
        const first = await getStoreDirectoryEntries(t0)
        const warm = await getStoreDirectoryEntries(
            t0 + STORE_DIRECTORY_TTL_MS - 1,
        )
        expect(warm).toBe(first)
        expect(repoMock.listStoreSitemapEntries).toHaveBeenCalledTimes(1)

        repoMock.listStoreSitemapEntries.mockResolvedValue([
            {
                site: 'nike.com',
                coupon_count: 2,
                last_updated: d('2026-09-02'),
            },
        ])
        // builtAt is Date.now() of the build, so expire relative to that.
        const expired = await getStoreDirectoryEntries(
            Date.now() + STORE_DIRECTORY_TTL_MS + 1,
        )
        expect(repoMock.listStoreSitemapEntries).toHaveBeenCalledTimes(2)
        expect(expired.map(e => e.base)).toEqual(['nike.com'])
    })

    it('concurrent cold callers share ONE build (no stampede)', async () => {
        const [a, b, c] = await Promise.all([
            getStoreDirectoryEntries(),
            getStoreDirectoryEntries(),
            getStoreDirectoryEntries(),
        ])
        expect(repoMock.listStoreSitemapEntries).toHaveBeenCalledTimes(1)
        expect(a).toBe(b)
        expect(b).toBe(c)
    })

    it('a failed rebuild keeps serving the previous entries; a failed COLD build throws', async () => {
        const warm = await getStoreDirectoryEntries(0)
        repoMock.listStoreSitemapEntries.mockRejectedValue(new Error('pg down'))
        const stale = await getStoreDirectoryEntries(
            Date.now() + STORE_DIRECTORY_TTL_MS + 1,
        )
        expect(stale).toBe(warm)

        resetStoreDirectoryCache()
        await expect(getStoreDirectoryEntries()).rejects.toThrow('pg down')
    })
})
