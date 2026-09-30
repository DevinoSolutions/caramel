'use client'

import CouponStatusBadge from '@/components/coupons/coupon-status-badge'
import {
    couponBadge,
    discountBadgeText,
    isRecentlyWorked,
    WORKED_VERIFIED_WINDOW_HOURS,
} from '@/lib/coupons'
import type { RecentlyWorkedCoupon } from '@/lib/recentlyWorkedCoupons'
import { formatWorkedAgo } from '@/lib/relativeTime'
import Link from 'next/link'
import { useEffect, useState } from 'react'

// The landing page's "Codes that just worked" strip: the newest codes Caramel
// shoppers applied successfully in the last 24 hours (coupon_signals), each
// shown Verified — the proof-by-use rule in lib/coupons.ts.
//
// The rows arrive as props from the server (RecentlyWorkedSection.tsx), so the
// tiles and their /coupons/<store> links are in the page's HTML. This client
// half only exists for the clock: `/` is an ISR page, so the HTML can be up to
// a revalidate window (plus the regeneration itself) old, and "Just worked"
// must be judged against the visitor's time, not the render's.

/**
 * The strip itself — pure, so it is testable without a network. Re-applies the
 * 24h window against `now` (the page is ISR-cached, so a row can age out
 * between the read and the render) and renders nothing when no code is left.
 */
export function RecentlyWorkedCouponsList({
    coupons,
    now,
}: {
    coupons: ReadonlyArray<RecentlyWorkedCoupon>
    now: number
}) {
    const fresh = coupons.filter(c => isRecentlyWorked(c.lastWorkedAt, now))
    if (fresh.length === 0) return null

    return (
        <section
            id="just-worked"
            aria-labelledby="just-worked-heading"
            className="relative py-24"
        >
            <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
                <div className="mb-12 text-center">
                    <h2
                        id="just-worked-heading"
                        className="mb-4 text-4xl font-extrabold leading-tight tracking-tight text-caramel lg:text-3xl"
                    >
                        Codes that just worked
                    </h2>
                    <p className="mx-auto max-w-2xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
                        Real checkouts: codes Caramel shoppers applied
                        successfully in the last {WORKED_VERIFIED_WINDOW_HOURS}{' '}
                        hours, newest first.
                    </p>
                </div>
                <ul className="grid grid-cols-4 gap-5 xl:grid-cols-3 lg:grid-cols-2 sm:grid-cols-1">
                    {fresh.map(coupon => (
                        <RecentlyWorkedTile
                            key={coupon.id}
                            coupon={coupon}
                            now={now}
                        />
                    ))}
                </ul>
            </div>
        </section>
    )
}

function RecentlyWorkedTile({
    coupon,
    now,
}: {
    coupon: RecentlyWorkedCoupon
    now: number
}) {
    const discount = discountBadgeText(
        coupon.discountType,
        coupon.discountAmount,
    )
    const workedAgo = formatWorkedAgo(coupon.lastWorkedAt, now)
    // Always the proven-by-use Verified badge here (every row is inside the
    // window by construction), derived through the same rule the /coupons
    // card uses rather than hard-coded, so the two can never disagree.
    const badge = couponBadge(null, coupon.lastWorkedAt, now)

    return (
        <li>
            {/* prefetch off: up to 8 tiles scrolling into view would otherwise
                fire 8 RSC requests for dynamic store pages on every landing
                visit — load the app does not need on its busiest page. */}
            <Link
                href={`/coupons/${coupon.storeDomain}`}
                prefetch={false}
                className="group flex h-full flex-col rounded-3xl border border-orange-100 bg-gradient-to-br from-orange-50/50 via-white to-orange-50/40 p-5 shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel dark:border-orange-900/50 dark:from-darkSurface dark:via-darkSurface dark:to-darkSurface dark:hover:border-orange-800/70"
            >
                <div className="mb-3 flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words text-sm font-semibold text-gray-500 dark:text-gray-400">
                        {coupon.storeDomain}
                    </span>
                    <span className="shrink-0 rounded-xl bg-gradient-to-br from-caramel to-orange-600 px-2.5 py-1 text-sm font-black text-white shadow-sm">
                        {discount ? `${discount} off` : 'DEAL'}
                    </span>
                </div>
                <h3 className="mb-3 line-clamp-2 font-semibold text-gray-900 dark:text-white">
                    {coupon.title}
                </h3>
                <div className="mt-auto flex flex-wrap items-center gap-2">
                    <code className="rounded-lg border border-dashed border-caramel/50 px-2 py-0.5 font-mono text-sm font-bold text-caramel">
                        {coupon.code}
                    </code>
                    {badge && <CouponStatusBadge badge={badge} />}
                </div>
                {workedAgo && (
                    <p className="mt-2 text-xs font-medium text-green-700 dark:text-green-400">
                        {workedAgo}
                    </p>
                )}
            </Link>
        </li>
    )
}

/**
 * Hydrates with the server's render time (so the first client render matches
 * the HTML exactly), then re-judges the 24h window and the "Worked Xh ago"
 * labels against the visitor's clock. A row that aged out while the ISR copy
 * was cached drops out; if none is left, the section disappears.
 */
export default function RecentlyWorkedCouponsStrip({
    coupons,
    renderedAt,
}: {
    coupons: ReadonlyArray<RecentlyWorkedCoupon>
    renderedAt: number
}) {
    const [now, setNow] = useState(renderedAt)
    useEffect(() => {
        setNow(Date.now())
    }, [])
    return <RecentlyWorkedCouponsList coupons={coupons} now={now} />
}
