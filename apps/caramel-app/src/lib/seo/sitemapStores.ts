// src/lib/seo/sitemapStores.ts
//
// Collapses the catalog's per-`site` aggregate rows into the CANONICAL store
// entries the sitemap emits — one entry per registrable domain, the same key
// the page canonicalizes to (resolveStoreDomain), gated by the same policy the
// page's robots meta uses (evaluateStorePageIndexability). Pure: no DB, no env.
//
// Measured on the served sitemap 2026-09-11: 4,311 raw `coupons.site` slugs
// collapse to 4,262 canonical bases — 84 subdomain slugs (athleta.gap.com,
// au.shein.com, shop.nhl.com …) fold into their base, 2 mixed-case slugs
// (Brooklinen.com, eNasco.com) fold into their lowercase twin, 40 bases were
// listed under several slugs at once (gap.com ×4, shein.com ×4, att.com ×3),
// 38 canonical targets (mattel.com, nfl.com, enasco.com, w3schools.com …) were
// missing entirely, and 1 slug (dhl.com-us-en-home.html) is not a domain.
import { evaluateStorePageIndexability } from '@/lib/seo/storeIndexability'
import { resolveStoreDomain } from '@/lib/storeDomain'

/**
 * Upper bound on grouped `coupons.site` rows feeding `/coupons/[store]`
 * entries — shared by the sitemap and the A–Z directory so both read the same
 * window of the catalog. The sitemap spec caps a single file at 50,000 URLs;
 * this stays well under it and bounds the query. If the catalog ever outgrows
 * it, the fix is a sitemap index, not a bigger number.
 */
export const STORE_SITEMAP_ROW_LIMIT = 5000

/** One `GROUP BY site` row from couponsRepo.listStoreSitemapEntries. */
export type StoreSitemapRow = {
    site: string | null
    coupon_count: number
    last_updated: Date | null
}

/** One canonical `/coupons/<base>` sitemap entry. */
export type StoreSitemapEntry = {
    base: string
    couponCount: number
    /** Newest `coupons.updated_at` across every slug folded into this base. */
    lastModified: Date | null
}

function newerOf(a: Date | null, b: Date | null): Date | null {
    if (!a) return b
    if (!b) return a
    return b.getTime() > a.getTime() ? b : a
}

/**
 * Group rows by their registrable domain, summing counts and keeping the
 * newest timestamp, then keep only the bases the indexability policy admits.
 * Rows whose `site` resolves to no store (null, '', a bare public suffix, a
 * non-domain string) are dropped — the page would `noindex` them anyway.
 * Output is sorted by base for a stable, diffable sitemap.
 */
export function collapseStoreRows(
    rows: ReadonlyArray<StoreSitemapRow>,
): StoreSitemapEntry[] {
    const byBase = new Map<string, StoreSitemapEntry>()
    for (const row of rows) {
        if (!row.site) continue
        const base = resolveStoreDomain(row.site)
        if (!base) continue
        const count = Number.isFinite(row.coupon_count)
            ? Math.max(0, row.coupon_count)
            : 0
        const existing = byBase.get(base)
        if (existing) {
            existing.couponCount += count
            existing.lastModified = newerOf(
                existing.lastModified,
                row.last_updated,
            )
        } else {
            byBase.set(base, {
                base,
                couponCount: count,
                lastModified: row.last_updated,
            })
        }
    }

    return Array.from(byBase.values())
        .filter(
            entry =>
                evaluateStorePageIndexability({
                    base: entry.base,
                    visibleCouponCount: entry.couponCount,
                }).indexable,
        )
        .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
}
