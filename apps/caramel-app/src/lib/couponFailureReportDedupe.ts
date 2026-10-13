// src/lib/couponFailureReportDedupe.ts
//
// At most ONE 'failed' report per reporter per coupon per 24h.
//
// POST /api/coupons/[id]/report is anonymous (the extension reports without a
// session) and each failure bumps coupon_signals.fail_count, which sinks a code
// at 2 and collapses it at 3 (coupons.ts isRecentlyFailing / keepsFailing). With
// no per-reporter dedupe a `curl` loop from ONE address flags any code in a
// second. With this, forging the collapse needs 3 distinct reporters per code,
// and what those can do is still only reorder/collapse: never a status change, a
// catalog write or a deletion, and one success clears it (DESIGN.md §2(q)).
//
// The reporter is the signed-in USER when there is a session and the client IP
// only for anonymous callers: two users behind one NAT must each keep their own
// report (and their coupon_reports attribution row).
//
// 'worked' reports are NOT limited here and never consume a slot: they never
// hide anything.
//
// STATE: an in-memory Map<key, expiry>, per process. It resets on every deploy
// and restart (a reporter can re-report once after one), and a multi-instance
// deploy would give each instance its own window. TODO: move to a shared store
// if the app is ever scaled past one instance (same stance as rateLimit.ts and
// classifyCartModelBudget.ts).
//
// BOUNDED: a Map entry per (reporter, coupon) must not grow without limit across
// rotating addresses (an IPv6 /64 is 2^64 of them), because this app has had
// memory/slowness outages. There are no per-key timers: entries are plain
// expiries, swept lazily. At MAX_KEYS the dedupe FAILS OPEN: the report is
// accepted without being tracked (a forger gets no throttle while the table is
// full, but no honest report is ever refused), and one throttled Sentry warning
// per hour says the cap is being hit.
import * as Sentry from '@sentry/nextjs'

const WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_KEYS = 50_000
/** A full table is re-swept for expired keys at most this often (a sweep is O(n)). */
const SWEEP_MIN_INTERVAL_MS = 60 * 1000
const CAP_REPORT_INTERVAL_MS = 60 * 60 * 1000

let maxKeys = DEFAULT_MAX_KEYS
const expiryByKey = new Map<string, number>()
let lastSweepAt = 0
/** A sustained cap-hit is ONE Sentry event per hour, not one per request. */
let nextCapReportAt = 0

export type FailedReportReporter =
    | { kind: 'user'; userId: string }
    | { kind: 'ip'; ip: string }

/** Short key: reporter kind + id, then the coupon id. */
function keyOf(reporter: FailedReportReporter, couponId: string): string {
    const who =
        reporter.kind === 'user' ? `u${reporter.userId}` : `i${reporter.ip}`
    return `${who}|${couponId}`
}

function sweepExpired(now: number): void {
    // forEach, not for-of: the tsconfig target cannot iterate a Map, and deleting
    // the visited key mid-forEach is well defined.
    expiryByKey.forEach((expiresAt, key) => {
        if (expiresAt <= now) expiryByKey.delete(key)
    })
    lastSweepAt = now
}

function reportCapHit(now: number): void {
    if (now < nextCapReportAt) return
    nextCapReportAt = now + CAP_REPORT_INTERVAL_MS
    Sentry.captureMessage(
        'coupon failed-report dedupe table is full: failing open',
        {
            level: 'warning',
            tags: { route: 'coupons/report', budget: 'failed-report-dedupe' },
            extra: { maxKeys, windowMs: WINDOW_MS },
        },
    )
}

/**
 * True when this report should be recorded: the first 'failed' report for
 * (reporter, couponId) in the window (it takes the slot), or ANY report while the
 * table is full (fail open, untracked). False only for a tracked duplicate.
 */
export function admitFailedReport(
    reporter: FailedReportReporter,
    couponId: string,
    now: number = Date.now(),
): boolean {
    const key = keyOf(reporter, couponId)
    const expiresAt = expiryByKey.get(key)
    if (expiresAt !== undefined && expiresAt > now) return false

    if (
        expiryByKey.size >= maxKeys &&
        now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS
    ) {
        sweepExpired(now)
    }
    if (expiryByKey.size >= maxKeys && expiresAt === undefined) {
        reportCapHit(now)
        return true
    }
    // An expired entry for this very key is overwritten in place.
    expiryByKey.set(key, now + WINDOW_MS)
    return true
}

/**
 * Give an admitted report's slot back: the signal write that followed it
 * failed, so the (retrying) client must not be deduped against a report that
 * never landed.
 */
export function releaseFailedReport(
    reporter: FailedReportReporter,
    couponId: string,
): void {
    expiryByKey.delete(keyOf(reporter, couponId))
}

/** Test-only: clear the table and optionally lower the cap. */
export function resetFailedReportDedupeForTests(
    options: { maxKeys?: number } = {},
): void {
    expiryByKey.clear()
    maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
    lastSweepAt = 0
    nextCapReportAt = 0
}
