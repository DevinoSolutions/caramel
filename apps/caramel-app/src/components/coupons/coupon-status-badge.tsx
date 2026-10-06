import type { CouponBadge, CouponStatusTier } from '@/lib/coupons'
import { WORKED_VERIFIED_WINDOW_HOURS } from '@/lib/coupons'

// Verification badge: green = verified (machine-verified by the pipeline OR
// proven by a shopper's successful apply in the last day — coupons.ts's
// couponBadge), amber = verified-but-restricted, grey = not yet verified,
// red = known not valid. Labels + which status maps to which tier live in
// lib/coupons.ts (F-006) — this Tailwind palette is the app-local half (the
// extension's popup badge keeps its own token-based equivalent; the 4-tier
// axis can't drift the way the 9-status axis did). Shared by the /coupons
// card and the landing page's "Codes that just worked" section so the two
// can never disagree on what "Verified" looks like.
const TIER_CLS: Record<CouponStatusTier, string> = {
    green: 'bg-green-100 text-green-700 ring-green-200 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-900/50',
    amber: 'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/50',
    grey: 'bg-gray-100 text-gray-600 ring-gray-200 dark:bg-white/10 dark:text-gray-300 dark:ring-white/20',
    red: 'bg-red-100 text-red-700 ring-red-200 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-900/50',
}

/** Tooltip on a badge that is green because a shopper's apply proved it. */
export const PROVEN_BY_RECENT_WORK_TITLE = `A Caramel shopper applied this code successfully in the last ${WORKED_VERIFIED_WINDOW_HOURS} hours`

export default function CouponStatusBadge({
    badge,
    verificationMessage,
    className = '',
}: {
    badge: CouponBadge
    /** The catalog's shopper-safe verification note, shown as the tooltip of a catalog-derived badge. */
    verificationMessage?: string | null
    className?: string
}) {
    const title = badge.provenByRecentWork
        ? PROVEN_BY_RECENT_WORK_TITLE
        : (verificationMessage ?? undefined)
    return (
        <span
            title={title}
            data-tier={badge.tier}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TIER_CLS[badge.tier]} ${className}`}
        >
            {badge.label}
        </span>
    )
}
