'use client'

import CouponStatusBadge from '@/components/coupons/coupon-status-badge'
import { couponBadge, discountBadgeText } from '@/lib/coupons'
import { formatWorkedAgo } from '@/lib/relativeTime'
import type { Coupon } from '@/types/coupon'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { toast } from 'sonner'

interface CouponCardProps {
    coupon: Coupon
    index: number
}

export default function CouponCard({ coupon, index }: CouponCardProps) {
    const [showCode, setShowCode] = useState(false)

    const handleCopyCode = async () => {
        if (coupon.code) {
            await navigator.clipboard.writeText(coupon.code)
            toast.success('Coupon code copied!')
            setShowCode(true)
            setTimeout(() => setShowCode(false), 3000)
        }
    }

    // Honest badge only: when the catalog has no discount amount the badge
    // says "DEAL" — it must NEVER invent a number (a fabricated "20% off"
    // is a false public claim on every unquantified coupon).
    const discount = discountBadgeText(
        coupon.discount_type,
        coupon.discount_amount,
    )

    // App-owned trust signal (W1) — "Just worked" / "Worked Xh ago" when the
    // extension last reported this coupon working, and only if that was
    // recent (<7 days). null (unshown) when there is no such report.
    const workedAgo = formatWorkedAgo(coupon.lastWorkedAt)
    // Catalog status badge, upgraded to Verified when a shopper's apply in
    // the last 24h proved an unverified code (coupons.ts couponBadge) — so a
    // green "Just worked" line never sits next to an "Unverified" badge.
    const badge = couponBadge(coupon.status, coupon.lastWorkedAt)

    return (
        <motion.div
            data-testid="coupon-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3, delay: index * 0.05 }}
            className="group relative overflow-hidden rounded-3xl border border-orange-100 bg-gradient-to-br from-orange-50/50 via-white to-orange-50/40 p-5 shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-lg dark:border-orange-900/50 dark:from-darkSurface dark:via-darkSurface dark:to-darkSurface dark:hover:border-orange-800/70"
        >
            <div className="flex items-center gap-5 md:flex-col md:items-start">
                {/* Left: Discount Badge */}
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-caramel to-orange-600 text-white shadow-md ring-1 ring-orange-200 dark:ring-orange-900/50">
                    <div className="text-center leading-tight">
                        {discount ? (
                            <>
                                <span className="block text-xl font-black md:text-lg">
                                    {discount}
                                </span>
                                <span className="text-[11px] font-semibold text-white/90">
                                    off
                                </span>
                            </>
                        ) : (
                            <span className="block text-sm font-black tracking-widest">
                                DEAL
                            </span>
                        )}
                    </div>
                </div>

                {/* Middle: Content */}
                <div className="min-w-0 flex-1">
                    <h3 className="mb-1 line-clamp-2 text-lg font-semibold text-gray-900 dark:text-white">
                        {coupon.title}
                    </h3>
                    {coupon.description && (
                        <p className="mb-2 line-clamp-1 text-sm text-gray-600 dark:text-gray-400">
                            {coupon.description}
                        </p>
                    )}
                    {/* TODO: post-signal-split this "used today" count should read
                        the app-owned workCount signal (couponSignals.recordUsage),
                        NOT the catalog's coupon.timesUsed — usage telemetry was
                        split out of the catalog (W1/W4-D2) so a use never bumps
                        coupons.updated_at. Deferred pending UX sign-off; see
                        docs/INGEST.md "Deferred human tasks". Behavior unchanged. */}
                    {(coupon.timesUsed ?? 0) > 0 && (
                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                            {coupon.timesUsed} used today
                        </p>
                    )}
                    {workedAgo && (
                        <p className="text-xs font-medium text-green-700 dark:text-green-400">
                            {workedAgo}
                        </p>
                    )}
                    {badge && (
                        <CouponStatusBadge
                            badge={badge}
                            verificationMessage={coupon.verificationMessage}
                            className="mt-2"
                        />
                    )}
                </div>

                {/* Right: CTA Button */}
                <div className="shrink-0 md:w-full">
                    <button
                        type="button"
                        onClick={handleCopyCode}
                        className="whitespace-nowrap rounded-2xl bg-gradient-to-r from-caramel to-orange-600 px-6 py-3 font-semibold text-white shadow-md transition-all hover:scale-105 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface md:w-full"
                    >
                        Get Coupon Code
                    </button>
                </div>
            </div>

            {/* Hover Overlay - Show Code */}
            {showCode && coupon.code && (
                <motion.div
                    role="status"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 flex items-center justify-center rounded-3xl bg-black/90 backdrop-blur-sm"
                >
                    <div className="text-center">
                        <p className="mb-2 text-sm text-gray-300">Your Code:</p>
                        <p className="mb-3 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-3xl font-black text-transparent">
                            {coupon.code}
                        </p>
                        <p className="text-xs text-gray-400">
                            Code copied to clipboard!
                        </p>
                    </div>
                </motion.div>
            )}
        </motion.div>
    )
}
