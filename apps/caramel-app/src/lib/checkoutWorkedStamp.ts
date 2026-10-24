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
//   2. DEDUPE. One stamp per account per coupon per 24h, from the PERSISTED
//      coupon_reports row, so a restart or a second instance cannot re-stamp. A
//      row only counts if the stamp really happened: POST /api/coupons/<id>/report
//      also writes a 'worked' attribution row for a LOW-TRUST account whose
//      report moved nothing, so a row counts only when the coupon's
//      last_worked_at is at or after it (within STAMP_CLOCK_TOLERANCE_MS, because
//      the row's created_at is stamped by the app and last_worked_at by the
//      database). A repeat of a real stamp is 'deduped': the earlier stamp
//      still stands, so the response is the same success. An UNSTAMPED row is
//      stamped now and reused as the attribution row. The in-memory 'worked'
//      slot is NOT consulted here, because the report route takes it for
//      unstamped reports too.
//   3. A PER-ACCOUNT DAILY CAP, COUPON_WORKED_STAMPS_PER_USER_PER_DAY, counted
//      from the account's persisted coupon_reports 'worked' rows in the last
//      24h (index coupon_reports_user_id_outcome_created_at_idx), so it
//      survives a restart and counts stamps on already-listed codes as well as
//      new ones (the submission cap only counts new rows). Over it: 'capped',
//      and a Sentry warning (at most hourly per process). The report route
//      applies the same count (workedStampCapSpent) to an established
//      account's {worked} report, which past the cap counts as low-trust.
//   4. THE PER-COUPON VELOCITY CAP (couponReportVelocity.ts), shared with the
//      report route's 'worked' reports.
//
// Steps 2 to 4 and the stamp run in ONE transaction that first takes the
// per-shopper advisory lock (couponsRepo.lockShopperUser, the one
// submitShopperCoupon holds), so two concurrent requests of one account cannot
// both read the same count and both pass. The stamp and its coupon_reports
// attribution row commit together or not at all. The count includes the
// 'worked' attribution rows the report route writes for signed-in users too: the
// cap is on how many codes an account vouched for in total, by either path.
//
// TODO: KNOWN LIMITATION, accepted by design (T-6222 review): a YOUNG account
// may still stamp "worked" on a code it listed ITSELF, so one new account can
// mint Verified badges for its own fresh codes, up to the shopper submission
// cap (20 new codes per 24h) and the daily stamp cap. The badge is only a 24h
// "a shopper says this worked" hint on a code nobody else listed. Closing it
// needs a second shopper to confirm (a worked quorum for shopper-listed codes)
// or an age gate on stamping one's own codes.
import type { Prisma } from '@/generated/prisma/client'
import { isEstablishedAccount } from '@/lib/accountReputation'
import type { ReportReporter } from '@/lib/couponReportDedupe'
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
/**
 * How far BEFORE an attribution row's created_at a coupon's last_worked_at may
 * be and still count as that row's stamp. The row's created_at comes from the
 * app clock, last_worked_at from the database's (and NOW() is the transaction's
 * start), so a genuine stamp can read slightly earlier than its own row. An
 * unstamped row followed within this window by somebody else's stamp is read as
 * stamped, which is harmless: the code is Verified either way.
 */
const STAMP_CLOCK_TOLERANCE_MS = 60 * 1000
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

/**
 * True when this account has already made COUPON_WORKED_STAMPS_PER_USER_PER_DAY
 * 'worked' attributions in the last 24h (persisted coupon_reports rows, so a
 * restart does not reset it), by the checkout capture or the report route. Call
 * it inside a transaction that holds couponsRepo.lockShopperUser, or two
 * concurrent requests can both read the same count. Raises the throttled Sentry
 * warning when the cap is spent.
 */
export async function workedStampCapSpent(
    tx: Pick<Prisma.TransactionClient, 'couponReport'>,
    userId: string,
): Promise<boolean> {
    const cap = env.COUPON_WORKED_STAMPS_PER_USER_PER_DAY
    const stampedToday = await tx.couponReport.count({
        where: {
            userId,
            outcome: 'worked',
            createdAt: { gt: new Date(Date.now() - DAY_MS) },
        },
    })
    if (stampedToday < cap) return false
    reportDailyCapHit(cap, Date.now())
    return true
}

export async function stampCheckoutWorked(
    args: CheckoutStampArgs,
): Promise<CheckoutStampOutcome> {
    const { couponId, userId } = args
    const established = isEstablishedAccount(args.accountCreatedAt)
    if (!args.submittedByUser && !established) return 'gated'

    const reporter: ReportReporter = { kind: 'user', userId, established }
    const tier = velocityTierOf(reporter)
    let velocityTaken = false
    try {
        return await prisma.$transaction(async tx => {
            await lockShopperUser(tx, userId)

            // The persisted truth: this account's latest 'worked' attribution
            // for this coupon in the last 24h, and whether it really stamped.
            const prior = await tx.couponReport.findFirst({
                where: {
                    couponId,
                    userId,
                    outcome: 'worked',
                    createdAt: { gt: new Date(Date.now() - DAY_MS) },
                },
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
            })
            if (prior) {
                const signal = await tx.couponSignal.findUnique({
                    where: { couponId },
                    select: { lastWorkedAt: true },
                })
                if (
                    signal?.lastWorkedAt &&
                    signal.lastWorkedAt.getTime() >=
                        prior.createdAt.getTime() - STAMP_CLOCK_TOLERANCE_MS
                ) {
                    return 'deduped' as const
                }
            }

            if (await workedStampCapSpent(tx, userId)) return 'capped' as const

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
            // An unstamped row of the same day (a low-trust /report) is reused
            // as the attribution row rather than doubling the daily count.
            if (!prior) {
                await tx.couponReport.create({
                    data: { couponId, userId, outcome: 'worked' },
                })
            }
            return 'stamped' as const
        })
    } catch (error) {
        // Nothing landed (the transaction rolled back): free the velocity slot
        // so the extension's retry counts.
        if (velocityTaken) releaseCouponReportVelocity('worked', couponId, tier)
        throw error
    }
}
