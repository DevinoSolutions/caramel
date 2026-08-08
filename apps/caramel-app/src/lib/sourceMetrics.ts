// The ONE producer of the public "source metrics" shape. Both consumers of
// listActiveSources() — the /api/sources GET route (client refetch after a
// source submission) and the /sources server component (SEO: initial data is
// server-rendered into the HTML) — must emit identical objects, or the
// hydrated table would flash different numbers than the crawler-visible HTML.
// Keeping the mapping here (not duplicated in the route and the page) makes
// that agreement structural instead of remembered.
import type { SourceRow } from '@/lib/couponsDb'

export type SourceMetrics = {
    id: string
    source: string
    websites: string[]
    numberOfCoupons: number
    successRate: number
    status: string
}

/** Maps the aggregated `sources` rows to the public shape, sorted by success rate descending (pre-existing /api/sources ordering, preserved verbatim). */
export function toSourceMetrics(rows: SourceRow[]): SourceMetrics[] {
    return rows
        .map(r => {
            const denom = r.total_used + r.total_expired
            const successRate = denom === 0 ? 0 : (r.total_used / denom) * 100
            return {
                id: r.id,
                source: r.source,
                websites: r.websites,
                numberOfCoupons: r.total_coupons,
                successRate: parseFloat(successRate.toFixed(2)),
                status: r.status,
            }
        })
        .sort((a, b) => b.successRate - a.successRate)
}
