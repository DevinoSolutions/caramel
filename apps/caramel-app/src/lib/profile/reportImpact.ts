// src/lib/profile/reportImpact.ts
//
// Derives the "your reports" numbers the account page is allowed to state.
//
// This is the section most likely to ship a FALSE CLAIM, so the rule is
// mechanical: the page may render only numbers derivable from real records.
// There are three copy tiers and the page renders the highest tier the data
// genuinely supports — never higher:
//
//   A  reportCount only                 → thanks framing, no impact claim
//   B  + confirmedCount                 → "N matched what we found"
//   C  + shoppersHelped (>= 10)         → "helped N shoppers"
//
// `shoppersHelped` is HARD-NULL here and that is deliberate, not an oversight:
// it would require a count of DISTINCT OTHER USERS who used a coupon whose
// state a given user's report changed. Nothing in this schema records who used
// a coupon — `Coupon.timesUsed` and `CouponSignal.workCount` are anonymous
// aggregates with no user attribution and no link back to the report that
// preceded them. Deriving "shoppers helped" from reportCount times anything,
// or from an aggregate counter, would be a fabricated public claim about
// another person's behaviour. If a real attribution table ever exists, count
// from IT and not from these. Until then tier C never renders.

/** Tier-C floor. "You helped 2 shoppers" is true and rhetorically worse than
 * silence — it makes a real contribution sound trivial. Below this the page
 * falls back to tier B (or A). */
export const SHOPPERS_HELPED_MIN = 10

/** One report joined to the catalog state of the coupon it was about. */
export interface ReportWithCouponState {
    outcome: string
    createdAt: Date
    coupon: {
        status: string
        expired: boolean
        /** The catalog's last-write stamp — the verification pipeline's
         * only-if-newer authority (see Coupon.updatedAt in schema.prisma). */
        updatedAt: Date
    } | null
}

/**
 * A report is CONFIRMED when our own catalog was written AFTER the report and
 * landed in a state that agrees with what the user told us.
 *
 * Both halves are load-bearing:
 *  - "after" (`coupon.updatedAt > report.createdAt`) is what makes this a
 *    RECHECK rather than a restatement of the state that was already there
 *    when they reported. Without it every report about an already-valid coupon
 *    would count itself as confirmed.
 *  - "agrees" is direction-aware: a `worked` report is confirmed by a live,
 *    unexpired, valid coupon; a `failed` report is confirmed by the catalog
 *    having since expired or de-validated it.
 *
 * A report whose coupon row is gone (or absent from the join) is NOT counted —
 * we cannot say our recheck agreed with something we can no longer see.
 */
export function isConfirmedReport(report: ReportWithCouponState): boolean {
    const { coupon } = report
    if (!coupon) return false
    if (coupon.updatedAt.getTime() <= report.createdAt.getTime()) return false

    const catalogSaysUsable = coupon.status === 'valid' && !coupon.expired
    if (report.outcome === 'worked') return catalogSaysUsable
    if (report.outcome === 'failed') return !catalogSaysUsable
    // An outcome outside the route's two-value vocabulary confirms nothing.
    return false
}

export interface ReportImpact {
    reportCount: number
    confirmedCount: number | null
    shoppersHelped: number | null
}

/** Which copy tier the data supports. `'none'` = render no section at all. */
export type ReportTier = 'none' | 'A' | 'B' | 'C'

/**
 * Picks the HIGHEST tier the payload genuinely supports, as a fall-through
 * chain rather than a feature flag: a tier is unlocked by its number being
 * present and meaningful, so a field that goes missing (or a count that drops
 * below the floor) silently degrades the copy instead of rendering a claim
 * with a hole in it.
 */
export function selectReportTier(reports: ReportImpact): ReportTier {
    if (reports.reportCount < 1) return 'none'
    if (
        reports.shoppersHelped !== null &&
        reports.shoppersHelped >= SHOPPERS_HELPED_MIN
    ) {
        return 'C'
    }
    if (reports.confirmedCount !== null && reports.confirmedCount >= 1) {
        return 'B'
    }
    return 'A'
}

/**
 * Folds a user's reports into the contract's `reports` block.
 *
 * `confirmedCount` is null — not 0 — when the user has no reports at all: with
 * nothing to confirm there is no confirmation RATE to state, and a literal
 * "0 matched what we found" reads as an accusation. Zero confirmations out of
 * real reports, on the other hand, is a true and renderable 0.
 */
export function summarizeReports(
    reports: ReportWithCouponState[],
): ReportImpact {
    if (reports.length === 0) {
        return { reportCount: 0, confirmedCount: null, shoppersHelped: null }
    }
    return {
        reportCount: reports.length,
        confirmedCount: reports.filter(isConfirmedReport).length,
        // See the module header: no per-user usage attribution exists.
        shoppersHelped: null,
    }
}
