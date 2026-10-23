// src/lib/checkoutWorkedStamp.ts
//
// Whether a shopper's checkout capture (POST /api/coupons/submit, source
// 'checkout') may stamp its code "worked", and the stamp itself (T-6222).
//
// The stamp is a trust signal: lastWorkedAt shows the code Verified for 24h,
// lists it in "Codes that just worked" (couponsRepo.listRecentlyWorkedCoupons)
// and clears a code's failing state. The request that asks for it is
// client-asserted: Origin and the consent proof are trivially forged by a
// non-browser client (see the submit route header). Before this policy any
// signed-in account could POST an already-listed supplier code with
// source 'checkout' and stamp it, at the mutation rate limit, with no limit on
// how many distinct codes it vouched for. Now a stamp needs, in order:
//
//   1. REPUTATION. The shopper either listed this code themselves (a new row,
//      or their own earlier submission: SubmitShopperCouponResult
//      .submittedByUser) or has an ESTABLISHED account (accountReputation.ts).
//      Otherwise nothing is stamped ('gated'): the code is still listed.
//   2. DEDUPE. One stamp per account per coupon per 24h (couponReportDedupe.ts,
//      the same 'worked' slot the report route uses). A repeat is 'deduped':
//      the earlier stamp still stands, so the response is the same success.
//   3. A PER-ACCOUNT DAILY CAP, COUPON_WORKED_STAMPS_PER_USER_PER_DAY, counted
//      from the account's persisted coupon_reports 'worked' rows in the last
//      24h, so it survives a restart and counts stamps on already-listed codes
//      as well as new ones (the submission cap only counts new rows). Over it:
//      'capped', and a Sentry warning (at most hourly per process).
//   4. THE PER-COUPON VELOCITY CAP (couponReportVelocity.ts), shared with the
//      report route's 'worked' reports.
//
// The stamp and its coupon_reports attribution row are ONE transaction, like
// the report route's signed-in path, and the attribution row is what step 3
// counts. NOTE the count includes the 'worked' attribution rows the report
// route writes too: the cap is on how many codes an account vouched for in
// total, by either path. It does not LIMIT the report route (TODO: if the
// report route's worked reports from one account ever need a daily cap, apply
// the same count there; today they are bounded by the mutation rate limit, the
// per-coupon dedupe and the per-coupon velocity cap).
import { isEstablishedAccount } from '@/lib/accountReputation'
import {
    admitReport,
    releaseReport,
    type ReportReporter,
} from '@/lib/couponReportDedupe'
import {
    admitCouponReportVelocity,
    releaseCouponReportVelocity,
} from '@/lib/couponReportVelocity'
import { recordWorked } from '@/lib/couponSignals'
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'
import * as Sentry from '@sentry/nextjs'

const DAY_MS = 24 * 60 * 60 * 1000
const CAP_REPORT_INTERVAL_MS = 60 * 60 * 1000
let nextCapReportAt = 0

/**
 * What happened to the stamp request.
 *  - 'stamped': lastWorkedAt written and the attribution row kept.
 *  - 'deduped': this account already stamped this coupon in the last 24h; the
 *    earlier stamp stands, nothing was written.
 *  - 'gated': the account has no standing to vouch for a code somebody else
 *    listed; nothing was written.
 *  - 'capped': the account's daily stamp cap or the coupon's hourly velocity cap
 *    was spent; nothing was written.
 */
export type CheckoutStampOutcome = 'stamped' | 'deduped' | 'gated' | 'capped'

export interface CheckoutStampArgs {
    couponId: string
    userId: string
    /** The session user's createdAt (accountReputation.isEstablishedAccount). */
    accountCreatedAt: Date | string | null | undefined
    /** SubmitShopperCouponResult.submittedByUser. */
    submittedByUser: boolean
}

/** Midnight UTC of `now`: the attribution row is one per (user, coupon, UTC day). */
function startOfUtcDay(now: Date): Date {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
}

function reportDailyCapHit(cap: number, now: number): void {
    if (now < nextCapReportAt) return
    nextCapReportAt = now + CAP_REPORT_INTERVAL_MS
    Sentry.captureMessage(
        'checkout worked-stamp daily cap hit: an account is vouching for codes faster than a shopper plausibly does',
        {
            level: 'warning',
            tags: { route: 'coupons/submit', budget: 'worked-stamp-daily' },
            // No account id: it is personal data and this is a counter.
            extra: { cap, windowMs: DAY_MS },
        },
    )
}

export async function stampCheckoutWorked(
    args: CheckoutStampArgs,
): Promise<CheckoutStampOutcome> {
    const { couponId, userId } = args
    const established = isEstablishedAccount(args.accountCreatedAt)
    if (!args.submittedByUser && !established) return 'gated'

    const reporter: ReportReporter = { kind: 'user', userId, established }
    if (!admitReport('worked', reporter, couponId)) return 'deduped'

    try {
        const now = new Date()
        const cap = env.COUPON_WORKED_STAMPS_PER_USER_PER_DAY
        const stampedToday = await prisma.couponReport.count({
            where: {
                userId,
                outcome: 'worked',
                createdAt: { gt: new Date(now.getTime() - DAY_MS) },
            },
        })
        if (stampedToday >= cap) {
            releaseReport('worked', reporter, couponId)
            reportDailyCapHit(cap, now.getTime())
            return 'capped'
        }

        if (!admitCouponReportVelocity('worked', couponId, now.getTime())) {
            releaseReport('worked', reporter, couponId)
            return 'capped'
        }

        try {
            await prisma.$transaction(async tx => {
                // Not caught: if the stamp fails the shopper-visible result
                // ("worked") would be a lie, so the failure surfaces as a 500.
                if (!(await recordWorked(couponId, reporter, tx))) {
                    // recordWorked refuses an id that is not a catalog row. This
                    // one was just inserted (or found listed) a moment ago, so it
                    // was deleted in between: surface it, never claim a stamp
                    // that did not land.
                    throw new Error(
                        `checkoutWorkedStamp: recordWorked found no catalog row for coupon ${couponId}`,
                    )
                }
                // Idempotent per (user, coupon, UTC day): a retry after a restart
                // (which empties the in-memory dedupe) must not double-count.
                const alreadyAttributed = await tx.couponReport.findFirst({
                    where: {
                        couponId,
                        userId,
                        outcome: 'worked',
                        createdAt: { gte: startOfUtcDay(now) },
                    },
                    select: { id: true },
                })
                if (!alreadyAttributed) {
                    await tx.couponReport.create({
                        data: { couponId, userId, outcome: 'worked' },
                    })
                }
            })
        } catch (error) {
            releaseCouponReportVelocity('worked', couponId, now.getTime())
            throw error
        }
        return 'stamped'
    } catch (error) {
        // Nothing landed: free the dedupe slot so the extension's retry counts.
        releaseReport('worked', reporter, couponId)
        throw error
    }
}
