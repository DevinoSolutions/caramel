// src/lib/anonymousReadCaches.ts
//
// In-process TTL caches in front of the anonymous, DB-heavy catalog reads
// (T-6226). Cloudflare reports `cf-cache-status: DYNAMIC` for these paths, so
// the routes' `s-maxage` headers absorb nothing and every request reached
// Postgres: DISTINCT/GROUP BY/ILIKE scans over the visible catalog, the same
// load shape behind the Aug-Sep 2026 healthcheck flaps.
//
// Keys come from the PARSED params (never the raw URL), so a unique query
// string cannot bust the cache, and the key space is bounded by the parsers
// (sitesLimit 0..100, search terms <= 100 chars under an LRU cap). The loaders
// are the couponsRepo reads untouched: no SQL here.
//
// Single instance by design, like supportedStoresCache.ts and rateLimit.ts.
// Search terms are free-form, so the LRU absorbs REPEATED terms (autocomplete
// prefixes, popular stores) but a caller sending unique terms still misses
// every time; the 'read' rate limit per IP is the only bound on those.
// TODO(T-6226): a prefix/trigram index for searchSupportedSites needs a
// migration (pg_trgm was dropped in 20260414231559) and was left out of this
// hardening PR, as was a concurrency budget for cache misses on that route.
import type {
    DiscountTypeRow,
    SiteCountRow,
    SiteRow,
    SourceRow,
    StatsRow,
} from '@/lib/couponsDb'
import {
    getCouponStats,
    listActiveSources,
    listFilterDiscountTypes,
    listFilterSites,
    listTopSites,
    searchSupportedSites,
} from '@/lib/couponsRepo'
import { createLoadingTtlLruCache } from '@/lib/ttlLruCache'

export const ANONYMOUS_READ_TTL_MS = 5 * 60 * 1000
// Matches the routes' own `s-maxage=300`, so an edge cache in front (if one is
// ever configured) and this cache never disagree about freshness.

const filterSites = createLoadingTtlLruCache<SiteRow[]>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 128,
})
const filterTypes = createLoadingTtlLruCache<DiscountTypeRow[]>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 1,
})
const stats = createLoadingTtlLruCache<StatsRow>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 1,
})
const topSites = createLoadingTtlLruCache<SiteCountRow[]>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 1,
})
const activeSources = createLoadingTtlLruCache<SourceRow[]>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 1,
})
const supportedSiteSearch = createLoadingTtlLruCache<SiteRow[]>({
    ttlMs: ANONYMOUS_READ_TTL_MS,
    maxEntries: 500,
})

/** `sitesLimit` must already be a clamped integer (see parseSitesLimit). */
export function cachedFilterSites(sitesLimit: number): Promise<SiteRow[]> {
    return filterSites.load(String(sitesLimit), () =>
        listFilterSites(sitesLimit),
    )
}

export function cachedFilterDiscountTypes(): Promise<DiscountTypeRow[]> {
    return filterTypes.load('types', () => listFilterDiscountTypes())
}

export function cachedCouponStats(): Promise<StatsRow> {
    return stats.load('stats', () => getCouponStats())
}

export function cachedTopSites(): Promise<SiteCountRow[]> {
    return topSites.load('top', () => listTopSites())
}

export function cachedActiveSources(): Promise<SourceRow[]> {
    return activeSources.load('active', () => listActiveSources())
}

/** `q` is the route's already-normalized, non-empty search term. */
export function cachedSearchSupportedSites(q: string): Promise<SiteRow[]> {
    return supportedSiteSearch.load(q, () => searchSupportedSites(q))
}

/** Drop every cached read (tests). */
export function resetAnonymousReadCaches(): void {
    for (const cache of [
        filterSites,
        filterTypes,
        stats,
        topSites,
        activeSources,
        supportedSiteSearch,
    ]) {
        cache.reset()
    }
}
