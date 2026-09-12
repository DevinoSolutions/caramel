// In-process cache of the collapsed, indexable store list that feeds the A–Z
// directory (/coupons/stores, /coupons/stores/[letter]) and the "Browse stores
// A–Z" letter strips on /coupons and /supported-stores.
//
// The read is the SAME one the sitemap performs — couponsRepo's
// listStoreSitemapEntries (one GROUP BY over visible coupons, ~4.3k rows)
// collapsed by sitemapStores.collapseStoreRows — so the directory can never
// list a store the sitemap omits or vice-versa. It is deliberately NOT a
// second, per-letter SQL query: a raw `site` first-character filter would
// split athleta.gap.com away from gap.com, i.e. re-implement the Public Suffix
// List collapse in SQL and drift from it.
//
// Why cache at all: that GROUP BY costs ~150 ms on prod (the same order as
// listTopSites, measured in #223's healthcheck-flap work), and the letter strip
// now sits on /coupons, the busiest marketing page. One build per 5 minutes per
// process keeps the strip free; 5 min of staleness is invisible for a list
// that changes on ingest pushes minutes-to-hours apart. Same shape as
// supportedStoresCache.ts: in-flight builds are de-duplicated (a stampede after
// expiry runs ONE query), and a rebuild that throws keeps serving the previous
// entry rather than 500ing a hub page. Single-instance by design (NF-13).
//
// The sitemap itself stays uncached (sitemap.ts reads the repo directly): its
// `lastmod` freshness is the whole point of #236, and crawlers hit it rarely.
import { listStoreSitemapEntries } from '@/lib/couponsRepo'
import type { StoreSitemapEntry } from '@/lib/seo/sitemapStores'
import {
    STORE_SITEMAP_ROW_LIMIT,
    collapseStoreRows,
} from '@/lib/seo/sitemapStores'

export const STORE_DIRECTORY_TTL_MS = 5 * 60 * 1000

type CachedDirectory = {
    entries: StoreSitemapEntry[]
    builtAt: number
}

let cached: CachedDirectory | null = null
let inFlight: Promise<CachedDirectory> | null = null

async function build(): Promise<CachedDirectory> {
    const rows = await listStoreSitemapEntries(STORE_SITEMAP_ROW_LIMIT)
    return { entries: collapseStoreRows(rows), builtAt: Date.now() }
}

/**
 * Every indexable store as a canonical, base-sorted entry — from memory while
 * younger than STORE_DIRECTORY_TTL_MS, rebuilt once (shared across concurrent
 * callers) otherwise. Callers must treat the array as read-only.
 */
export async function getStoreDirectoryEntries(
    now: number = Date.now(),
): Promise<ReadonlyArray<StoreSitemapEntry>> {
    if (cached && now - cached.builtAt < STORE_DIRECTORY_TTL_MS) {
        return cached.entries
    }
    if (!inFlight) {
        inFlight = build()
            .then(fresh => {
                cached = fresh
                return fresh
            })
            .finally(() => {
                inFlight = null
            })
    }
    try {
        return (await inFlight).entries
    } catch (err) {
        if (cached) return cached.entries
        throw err
    }
}

/** Drop the cached list (tests). */
export function resetStoreDirectoryCache(): void {
    cached = null
    inFlight = null
}
