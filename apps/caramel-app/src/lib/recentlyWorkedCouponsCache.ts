// In-process cache behind GET /api/coupons/recently-worked, the public read of
// the "Codes that just worked" list. (The landing page itself server-renders
// the list through readRecentlyWorkedCoupons below, not through this route.)
//
// Why cache: the route is public and unauthenticated. The read itself is
// cheap (an index range scan over one day of coupon_signals, LIMIT 8 — see
// couponsRepo.listRecentlyWorkedCoupons), but "cheap × every caller" on the
// single Node main thread is exactly the load shape behind the Aug–Sep
// healthcheck flaps. One read per 5 minutes per process makes it free; the
// route adds a matching `s-maxage=300` so an edge cache can absorb it too.
// Five minutes of staleness is harmless: rows carry an absolute lastWorkedAt
// that the caller formats against its own clock (coupons.ts isRecentlyWorked).
//
// Same shape as storeDirectoryCache.ts / supportedStoresCache.ts: in-flight
// builds are de-duplicated (a stampede after expiry runs ONE query), and a
// rebuild that throws keeps serving the previous entry (reporting the failure
// to Sentry); with no previous entry the error propagates to the route, which reports it (handleRouteError →
// Sentry). Single-instance by design (NF-13).
import { listRecentlyWorkedCoupons } from '@/lib/couponsRepo'
import type { RecentlyWorkedCoupon } from '@/lib/recentlyWorkedCoupons'
import { RECENTLY_WORKED_COUPONS_LIMIT } from '@/lib/recentlyWorkedCoupons'
import { resolveStoreDomain } from '@/lib/storeDomain'
import * as Sentry from '@sentry/nextjs'

export const RECENTLY_WORKED_TTL_MS = 5 * 60 * 1000

type CachedRecentlyWorked = {
    coupons: RecentlyWorkedCoupon[]
    builtAt: number
}

let cached: CachedRecentlyWorked | null = null
let inFlight: Promise<CachedRecentlyWorked> | null = null

/**
 * The newest codes shoppers applied successfully in the last 24h, read now
 * (UNCACHED), as the section renders them. The landing page calls this
 * directly: `/` is an ISR page, so its own revalidate window is the cache and
 * a second in-process layer would only delay a fresh code by another 5
 * minutes. The API route goes through getRecentlyWorkedCoupons below.
 */
export async function readRecentlyWorkedCoupons(): Promise<
    RecentlyWorkedCoupon[]
> {
    const rows = await listRecentlyWorkedCoupons(RECENTLY_WORKED_COUPONS_LIMIT)
    const coupons: RecentlyWorkedCoupon[] = []
    for (const row of rows) {
        // The tile links to /coupons/<registrable domain>; a site that has
        // none (a bare public suffix like `co.uk`) has no store page to link
        // to, so it is not a store this strip can show — the same rule the
        // store pages themselves apply (storeDomain.ts).
        const storeDomain = resolveStoreDomain(row.site)
        if (!storeDomain) continue
        coupons.push({
            id: row.id,
            code: row.code,
            title: row.title,
            storeDomain,
            discountType: row.discount_type,
            discountAmount: row.discount_amount,
            lastWorkedAt: row.lastWorkedAt.toISOString(),
        })
    }
    return coupons
}

async function build(): Promise<CachedRecentlyWorked> {
    return { coupons: await readRecentlyWorkedCoupons(), builtAt: Date.now() }
}

/**
 * The newest codes shoppers applied successfully in the last 24h — from
 * memory while younger than RECENTLY_WORKED_TTL_MS, rebuilt once (shared across
 * concurrent callers) otherwise. Callers must treat the array as read-only.
 */
export async function getRecentlyWorkedCoupons(
    now: number = Date.now(),
): Promise<ReadonlyArray<RecentlyWorkedCoupon>> {
    if (cached && now - cached.builtAt < RECENTLY_WORKED_TTL_MS) {
        return cached.coupons
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
        return (await inFlight).coupons
    } catch (err) {
        if (!cached) throw err
        // Serving the previous strip is the right outcome for visitors, but
        // the failed rebuild must still be seen — it is not the route's error
        // to report, because the route succeeds.
        Sentry.captureException(err, {
            tags: { area: 'recentlyWorkedCouponsCache.rebuild' },
        })
        return cached.coupons
    }
}

/** Drop the cached list (tests). */
export function resetRecentlyWorkedCouponsCache(): void {
    cached = null
    inFlight = null
}
