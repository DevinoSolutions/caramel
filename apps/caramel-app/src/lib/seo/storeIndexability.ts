// src/lib/seo/storeIndexability.ts
//
// THE ONE indexability policy for `/coupons/[store]` pages. Both consumers —
// the sitemap (src/app/sitemap.ts, via sitemapStores.ts) and the page's own
// generateMetadata ((marketing)/coupons/[store]/page.tsx) — consult THIS
// function, so "is this store page in the sitemap" and "does this store page
// carry noindex" can never disagree again.
//
// Why it exists (GSC, 2026-09-11): the sitemap listed 4,317 store URLs and
// Google knew 4,289 of them as "unknown". Three independent computations had
// drifted apart: the sitemap emitted raw `coupons.site` slugs (84 subdomains
// like athleta.gap.com, 2 mixed-case like eNasco.com, 1 non-domain), the page
// canonicalized every slug to its registrable base, and the page's noindex
// rule ran on a count the sitemap never looked at — so the sitemap happily
// listed pages whose canonical pointed elsewhere and pages that served
// `noindex`. See caramel-artifact/seo-2026-09-11/audit-findings.md §Sitemap.
//
// Pure by design: no DB, no env, no I/O. The caller resolves the slug through
// resolveStoreDomain() and counts visible coupons; this function only decides.

/** Why a store page is NOT indexable. `null` means it is. */
export type StoreIndexabilityReason = 'not-a-store' | 'no-coupons' | null

export type StoreIndexabilityInput = {
    /**
     * The registrable domain the page canonicalizes to — resolveStoreDomain()
     * output. `null`/'' means the slug names no real store (a bare public
     * suffix like `co.uk`, a garbage path like `dhl.com-us-en-home.html`, an
     * unregistrable TLD) and the page can only render its empty state.
     */
    base: string | null | undefined
    /**
     * Visible coupons (visibleCouponsWhere) for that base — the SAME number
     * the page's prose renders. Zero-coupon pages are soft-404 bloat.
     */
    visibleCouponCount: number
}

export type StoreIndexability = {
    indexable: boolean
    reason: StoreIndexabilityReason
}

/**
 * A store page is indexable exactly when it names a real store AND currently
 * lists at least one visible coupon. Everything else is `noindex, follow` on
 * the page and absent from the sitemap.
 *
 * ONE coupon is enough: a page with a single live code is still a real answer
 * to "<store> coupon code", and the catalog's counts move daily — raising the
 * bar would churn thousands of URLs in and out of the sitemap as codes expire
 * and reappear, which is worse for crawl budget than a few thin-but-true pages.
 */
export function evaluateStorePageIndexability(
    input: StoreIndexabilityInput,
): StoreIndexability {
    const base = typeof input.base === 'string' ? input.base.trim() : ''
    if (!base) return { indexable: false, reason: 'not-a-store' }
    if (
        !Number.isFinite(input.visibleCouponCount) ||
        input.visibleCouponCount < 1
    ) {
        return { indexable: false, reason: 'no-coupons' }
    }
    return { indexable: true, reason: null }
}
