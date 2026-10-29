// src/lib/accountReputation.ts
//
// The one definition of an "established" account, for the coupon trust signals
// (T-6222 / T-6227). An account costs a verified email and nothing else, so on
// its own it proves little: a forger can mint a batch of them in a minute. What
// a fresh account cannot buy is age. An account older than
// COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS is "established":
//   - its failure report weighs as a signed-in account does toward a quorum
//     (couponSignals.ts REPORTER_WEIGHT); a younger one weighs as an anonymous
//     network and shares the capped anonymous pool (coupons.ts
//     MAX_LOW_TRUST_FAIL_WEIGHT);
//   - it may stamp "worked" on a code somebody else listed through the checkout
//     capture (checkoutWorkedStamp.ts); a younger one may only stamp codes it
//     listed itself.
// This is a speed bump, not proof of a real person: a patient forger waits the
// days out. The per-coupon velocity cap (couponReportVelocity.ts) and the
// per-account daily stamp cap bound what even an aged account can do.
import { env } from '@/lib/env'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * True when the account is at least COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS old. A
 * missing or unparseable creation time is NOT established: an account whose age
 * cannot be read gets no trust. Pure over its inputs (the env default aside);
 * `now` is a parameter so tests need no fake clock.
 */
export function isEstablishedAccount(
    createdAt: Date | string | null | undefined,
    now: number = Date.now(),
    minAgeDays: number = env.COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS,
): boolean {
    if (createdAt === null || createdAt === undefined) return false
    const createdMs = new Date(createdAt).getTime()
    if (Number.isNaN(createdMs)) return false
    return now - createdMs >= minAgeDays * DAY_MS
}
