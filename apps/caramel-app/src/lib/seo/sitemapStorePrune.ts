// src/lib/seo/sitemapStorePrune.ts
//
// Which `/coupons/<store>` URLs the sitemap leaves out because Google gave
// them nothing in 90 days. Pure: no DB, no env. Consumed by src/app/sitemap.ts
// ONLY — never by robots.ts, storeIndexability.ts or the store page, so a
// pruned page stays live, indexable (no noindex) and linked from the A–Z
// directory; it just stops being offered in the sitemap.
//
// Why (T-15493): most of the ~3,900 store URLs never earned a single GSC
// impression in the window, yet each is offered to Google as one of "our"
// pages. Shrinking the sitemap to the pages Google actually uses is the first
// step of a measured, reversible prune. It is measured SEPARATELY from the
// search-intent titles (#491) and the `lastmod` floor (#693) — those landed
// first and have their own read-outs; do not stack another sitemap change on
// this one until it has its own.
//
// Reversible by one revert: reverting the PR, or emptying
// SITEMAP_PRUNE_BASES, puts every URL back on the next sitemap fetch.
import {
    SITEMAP_PRUNE_BASES,
    SITEMAP_PRUNE_WINDOW_START,
} from '@/lib/seo/sitemapStorePrune.data'
import type { StoreSitemapEntry } from '@/lib/seo/sitemapStores'

const PRUNE_BASES: ReadonlySet<string> = new Set(SITEMAP_PRUNE_BASES)

const WINDOW_START_MS = Date.parse(`${SITEMAP_PRUNE_WINDOW_START}T00:00:00Z`)

/**
 * True when the store's sitemap `<loc>` should be omitted: it is on the
 * zero-impression list AND its page has existed for the whole measurement
 * window (its oldest visible coupon predates the window start).
 *
 * The age half is the "too new to judge" guard. The list was generated offline
 * from GSC, which cannot say how old a page is; a store that gained its first
 * coupon after the window opened has not had 90 days to earn an impression, so
 * a zero there proves nothing. Unknown age (`null`) is NOT pruned — when we
 * cannot show a page was old enough to judge, it stays in the sitemap.
 */
export function isPrunedFromSitemap(
    entry: Pick<StoreSitemapEntry, 'base' | 'firstCreatedAt'>,
): boolean {
    if (!PRUNE_BASES.has(entry.base)) return false
    if (!entry.firstCreatedAt) return false
    return entry.firstCreatedAt.getTime() <= WINDOW_START_MS
}
