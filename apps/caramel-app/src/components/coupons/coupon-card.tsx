'use client'

import CouponFeedback from '@/components/coupons/CouponFeedback'
import CouponStatusBadge from '@/components/coupons/coupon-status-badge'
import {
    couponBadge,
    discountBadgeText,
    isRecentlyFailing,
} from '@/lib/coupons'
import { formatFailedAgo, formatWorkedAgo } from '@/lib/relativeTime'
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
    // Unlike showCode (a 3-second overlay), this stays true once the shopper
    // has copied the code, so the "Did it work?" question outlives the overlay.
    const [copied, setCopied] = useState(false)
    // False when the browser refused the clipboard write, so the overlay tells
    // the shopper to copy the code by hand instead of claiming it was copied.
    const [clipboardWorked, setClipboardWorked] = useState(true)

    const handleCopyCode = async () => {
        if (!coupon.code) return
        // The browser may refuse the write (document not focused, in-app
        // browsers, Permissions-Policy, insecure context: Sentry CARAMEL-2F).
        // The code is still shown, longer, so the shopper can copy it by hand.
        let wrote = true
        try {
            await navigator.clipboard.writeText(coupon.code)
        } catch {
            wrote = false
        }
        if (wrote) toast.success('Coupon code copied!')
        else toast.info('Copy the code shown on the card')
        setClipboardWorked(wrote)
        setShowCode(true)
        setCopied(true)
        setTimeout(() => setShowCode(false), wrote ? 3000 : 15000)
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
    //
    // A code reported failing again since its last success is shown as such
    // INSTEAD: the later failure supersedes the earlier success, so neither the
    // "Worked Xh ago" line nor the proven-by-use Verified upgrade (both read
    // lastWorkedAt) may sit beside a "Reported not working" hint. These are
    // shopper/extension reports, so the hint says "Reported", never "Broken".
    const failing = isRecentlyFailing(coupon)
    const failedAgo = failing ? formatFailedAgo(coupon.lastFailedAt) : null
    const lastWorkedAt = failing ? null : coupon.lastWorkedAt
    const workedAgo = formatWorkedAgo(lastWorkedAt)
    // Catalog status badge, upgraded to Verified when a shopper's apply in
    // the last 24h proved an unverified code (coupons.ts couponBadge) — so a
    // green "Just worked" line never sits next to an "Unverified" badge.
    const catalogBadge = couponBadge(coupon.status, lastWorkedAt)
    // A code shoppers keep reporting as not working must not carry the green
    // Verified badge beside that hint: the catalog's check is older than the
    // reports. Other tiers (unverified, restricted, ...) are unaffected.
    const badge =
        coupon.keepsFailing && catalogBadge?.tier === 'green'
            ? null
            : catalogBadge

    return (
        <motion.div
            data-testid="coupon-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            // Stagger within a batch only: `index` counts from the top of
            // the whole list, and a 20-card page would otherwise hold the
            // next page's cards back 1-2s.
            transition={{ duration: 0.3, delay: (index % 10) * 0.05 }}
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
                    {failedAgo && (
                        <p
                            className="text-xs font-medium text-amber-700 dark:text-amber-400"
                            title="Based on reports from shoppers and the Caramel extension, not a check we ran."
                        >
                            {failedAgo}
                        </p>
                    )}
                    {coupon.newCustomersOnly && (
                        <span
                            data-testid="coupon-new-customers-only"
                            className="mr-2 mt-2 inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700 ring-1 ring-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:ring-orange-900/50"
                            title="This code works only for a new account at this store."
                        >
                            New customers only
                        </span>
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

            {/* Client-only: mounts after the copy click, so it is never in the
                server HTML. */}
            {copied && <CouponFeedback couponId={coupon.id} />}

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
                            {clipboardWorked
                                ? 'Code copied to clipboard!'
                                : 'Select the code above to copy it'}
                        </p>
                    </div>
                </motion.div>
            )}
        </motion.div>
    )
}
