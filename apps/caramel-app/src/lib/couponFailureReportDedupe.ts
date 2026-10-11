// src/lib/couponFailureReportDedupe.ts
//
// At most ONE 'failed' report per client IP per coupon per 24h.
//
// POST /api/coupons/[id]/report is anonymous (the extension reports without a
// session) and each failure bumps coupon_signals.fail_count, which sinks a code
// at 2 and collapses it at 3 (coupons.ts isRecentlyFailing / keepsFailing). With
// no per-reporter dedupe a `curl` loop from ONE address flags any code in a
// second. With this, forging the collapse needs 3 distinct IPs per code, and
// what those can do is still only reorder/collapse: never a status change, a
// catalog write or a deletion, and one success clears it (DESIGN.md §2(q)).
//
// 'worked' reports are NOT limited here: they never hide anything.
//
// In-memory like rateLimit.ts and classifyCartModelBudget.ts: correct for the
// ONE web instance the root compose runs. TODO: move to a shared store if the app
// is ever scaled past one instance (each instance would admit its own first
// report, so a forger would need 3 IPs PER INSTANCE-hop, not 3 in total).
// Memory is bounded by the route's per-IP `mutation` rate limit: one key per
// (ip, coupon) report that got past it, each expiring after the window.
import { RateLimiterMemory } from 'rate-limiter-flexible'

const WINDOW_SECONDS = 24 * 60 * 60

let limiter = new RateLimiterMemory({ points: 1, duration: WINDOW_SECONDS })

const keyOf = (ip: string, couponId: string) => `${ip}:${couponId}`

/**
 * True when this is the first 'failed' report for (ip, couponId) in the window
 * (and consumes it); false for a duplicate. Anything other than the limiter's
 * "points exhausted" rejection is a real error and propagates.
 */
export async function admitFailedReport(client: {
    ip: string
    couponId: string
}): Promise<boolean> {
    try {
        await limiter.consume(keyOf(client.ip, client.couponId), 1)
        return true
    } catch (rejection) {
        if (rejection instanceof Error) throw rejection
        return false
    }
}

/**
 * Give an admitted report's slot back: the signal write that followed it
 * failed, so the (retrying) client must not be deduped against a report that
 * never landed.
 */
export async function releaseFailedReport(client: {
    ip: string
    couponId: string
}): Promise<void> {
    await limiter.reward(keyOf(client.ip, client.couponId), 1)
}

/** Test-only reset of the dedupe window. */
export function resetFailedReportDedupeForTests(): void {
    limiter = new RateLimiterMemory({ points: 1, duration: WINDOW_SECONDS })
}
