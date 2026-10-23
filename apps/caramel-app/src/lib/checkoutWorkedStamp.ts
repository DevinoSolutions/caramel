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
//   2. DEDUPE. One stamp per account per coupon per 24h: the in-memory slot
//      (couponReportDedupe.ts, the same 'worked' slot the report route uses) is
//      the fast path, and the PERSISTED coupon_reports row is the truth, so a
//      restart or a second instance cannot re-stamp. A repeat is 'deduped': the
//      earlier stamp still stands, so the response is the same success.
//   3. A PER-ACCOUNT DAILY CAP, COUPON_WORKED_STAMPS_PER_USER_PER_DAY, counted
//      from the account's persisted coupon_reports 'worked' rows in the last
//      24h (index coupon_reports_user_id_outcome_created_at_idx), so it
//      survives a restart and counts stamps on already-listed codes as well as
//      new ones (the submission cap only counts new rows). Over it: 'capped',
//      and a Sentry warning (at most hourly per process).
//   4. THE PER-COUPON VELOCITY CAP (couponReportVelocity.ts), shared with the
//      report route's 'worked' reports.
//
// Steps 2 to 4 and the stamp run in ONE transaction that first takes the
// per-shopper advisory lock (couponsRepo.lockShopperUser, the one
// submitShopperCoupon holds), so two concurrent requests of one account cannot
// both read the same count and both pass. The stamp and its coupon_reports
// attribution row commit together or not at all. NOTE the count includes the
// 'worked' attribution rows the report route writes for signed-in users too: the
// cap is on how many codes an account vouched for in total, by either path. It
// does not LIMIT the report route (TODO: if the report route's worked reports
// from one account ever need a daily cap, apply the same count there; today they
// are bounded by the mutation rate limit, the per-coupon dedupe, the account's
// reputation and the per-coupon velocity cap).
//
// TODO: KNOWN LIMITATION, accepted by design (T-6222 review): a YOUNG account
// may still stamp "worked" on a code it listed ITSELF, so one new account can
// mint Verified badges for its own fresh codes, up to the shopper submission
// cap (20 new codes per 24h) and the daily stamp cap. The badge is only a 24h
// "a shopper says this worked" hint on a code nobody else listed. Closing it
// needs a second shopper to confirm (a worked quorum for shopper-listed codes)
// or an age gate on stamping one's own codes.
import { isEstablishedAccount } from '@/lib/accountReputation'
import {
    admitReport,
    releaseReport,
    type ReportReporter,
} from '@/lib/couponReportDedupe'
import {
    admitCouponReportVelocity,
    releaseCouponReportVelocity,
    velocityTierOf,
} from '@/lib/couponReportVelocity'
import { recordWorked } from '@/lib/couponSignals'
import { lockShopperUser } from '@/lib/couponsRepo'
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

    const tier = velocityTierOf(reporter)
    const cap = env.COUPON_WORKED_STAMPS_PER_USER_PER_DAY
    let velocityTaken = false
    let dailyCapHit = false
    try {
        const outcome = await prisma.$transaction(async tx => {
            await lockShopperUser(tx, userId)
            const since = new Date(Date.now() - DAY_MS)

            // The persisted truth behind the in-memory slot.
            const alreadyStamped = await tx.couponReport.findFirst({
                where: {
                    couponId,
                    userId,
                    outcome: 'worked',
                    createdAt: { gt: since },
                },
                select: { id: true },
            })
            if (alreadyStamped) return 'deduped' as const

            const stampedToday = await tx.couponReport.count({
                where: { userId, outcome: 'worked', createdAt: { gt: since } },
            })
            if (stampedToday >= cap) {
                dailyCapHit = true
                return 'capped' as const
            }

            if (!admitCouponReportVelocity('worked', couponId, tier)) {
                return 'capped' as const
            }
            velocityTaken = true

            // Not caught: if the stamp fails the shopper-visible result
            // ("worked") would be a lie, so the failure surfaces as a 500.
            // forceStamp: the policy above IS the vetting; without it a young
            // account's own fresh code would be treated as a low-trust report.
            if (
                !(await recordWorked(couponId, reporter, tx, {
                    forceStamp: true,
                }))
            ) {
                // recordWorked refuses an id that is not a catalog row. This
                // one was just inserted (or found listed) a moment ago, so it
                // was deleted in between: surface it, never claim a stamp that
                // did not land.
                throw new Error(
                    `checkoutWorkedStamp: recordWorked found no catalog row for coupon ${couponId}`,
                )
            }
            await tx.couponReport.create({
                data: { couponId, userId, outcome: 'worked' },
            })
            return 'stamped' as const
        })

        if (outcome === 'capped') {
            // Nothing landed: give the dedupe slot back so the stamp can count
            // once the cap clears.
            releaseReport('worked', reporter, couponId)
            if (dailyCapHit) reportDailyCapHit(cap, Date.now())
        }
        return outcome
    } catch (error) {
        // Nothing landed (the transaction rolled back): free both slots so the
        // extension's retry counts.
        if (velocityTaken) releaseCouponReportVelocity('worked', couponId, tier)
        releaseReport('worked', reporter, couponId)
        throw error
    }
}
