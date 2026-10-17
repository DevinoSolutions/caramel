// src/lib/couponReportDedupe.ts
//
// At most ONE report of each kind per reporter per coupon per 24h, for the three
// anonymous trust signals a shopper's extension (or the website card) sends:
//
//   'failed' — POST /api/coupons/[id]/report {failed}: bumps fail_count, which
//              sinks a code at 2 and collapses it at 3 (coupons.ts
//              isRecentlyFailing / keepsFailing).
//   'worked' — POST /api/coupons/[id]/report {worked}: stamps last_worked_at,
//              which shows the code as Verified for 24h, lists it in "Codes that
//              just worked", and clears a code's failing state.
//   'used'   — POST /api/coupons/increment: bumps work_count.
//
// Without a per-reporter dedupe one reporter repeating a report could move any
// of these alone. With it, each kind needs a distinct reporter per count. The
// three kinds have separate slots: a successful apply sends both 'worked' and
// 'used', and a shopper who reports a code worked can still report it failed
// later (and the reverse).
//
// The reporter is the signed-in USER when there is a session and the client IP
// only for anonymous callers: two users behind one NAT must each keep their own
// report (and their coupon_reports attribution row). Two ANONYMOUS shoppers
// behind one IP share a slot per coupon per kind: the second one's repeat of the
// same report within 24h is not counted.
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
// expiries, swept lazily. At the cap the dedupe FAILS OPEN: the report is
// accepted without being tracked (a forger gets no throttle while the table is
// full, but no honest report is ever refused), and one throttled Sentry warning
// per hour per kind says the cap is being hit.
//
// ONE TABLE PER KIND, each with its own cap. Every successful apply sends a
// 'worked' report and a use, so honest success traffic is the bulk of the keys;
// in one shared table it could fill the cap and switch off the 'failed' dedupe,
// which is the one that stops a code being flagged by a single reporter.
import { getClientIp } from '@/lib/rateLimit'
import * as Sentry from '@sentry/nextjs'
import type { NextRequest } from 'next/server'

const WINDOW_MS = 24 * 60 * 60 * 1000

/** What a report says. Each kind has its own slot per (reporter, coupon). */
export type ReportKind = 'worked' | 'failed' | 'used'

/** Sentry route tag for a cap hit: the route that sends this kind. */
const ROUTE_OF_KIND: Record<ReportKind, string> = {
    worked: 'coupons/report',
    failed: 'coupons/report',
    used: 'coupons/increment',
}
/** Per kind, so the three tables together hold at most 3x this. */
const DEFAULT_MAX_KEYS_PER_KIND = 50_000
/** A full table is re-swept for expired keys at most this often (a sweep is O(n)). */
const SWEEP_MIN_INTERVAL_MS = 60 * 1000
const CAP_REPORT_INTERVAL_MS = 60 * 60 * 1000

interface KindTable {
    expiryByKey: Map<string, number>
    lastSweepAt: number
    /** A sustained cap-hit is ONE Sentry event per hour, not one per request. */
    nextCapReportAt: number
}

function emptyTable(): KindTable {
    return { expiryByKey: new Map(), lastSweepAt: 0, nextCapReportAt: 0 }
}

let maxKeysPerKind = DEFAULT_MAX_KEYS_PER_KIND
const tables: Record<ReportKind, KindTable> = {
    worked: emptyTable(),
    failed: emptyTable(),
    used: emptyTable(),
}

export type ReportReporter =
    | { kind: 'user'; userId: string }
    | { kind: 'ip'; ip: string }

/**
 * The reporter a request counts as: its signed-in user, else its client IP
 * (getClientIp, the same address the rate limiter uses). Both report routes
 * call this, so a shopper is one reporter on both.
 */
export function reporterFor(
    userId: string | null,
    req: NextRequest,
): ReportReporter {
    return userId
        ? { kind: 'user', userId }
        : { kind: 'ip', ip: getClientIp(req) }
}

/** Short key within a kind's table: reporter kind + id, then the coupon id. */
function keyOf(reporter: ReportReporter, couponId: string): string {
    const who =
        reporter.kind === 'user' ? `u${reporter.userId}` : `i${reporter.ip}`
    return `${who}|${couponId}`
}

function sweepExpired(table: KindTable, now: number): void {
    // forEach, not for-of: the tsconfig target cannot iterate a Map, and deleting
    // the visited key mid-forEach is well defined.
    table.expiryByKey.forEach((expiresAt, key) => {
        if (expiresAt <= now) table.expiryByKey.delete(key)
    })
    table.lastSweepAt = now
}

function reportCapHit(kind: ReportKind, table: KindTable, now: number): void {
    if (now < table.nextCapReportAt) return
    table.nextCapReportAt = now + CAP_REPORT_INTERVAL_MS
    Sentry.captureMessage('coupon report dedupe table is full: failing open', {
        level: 'warning',
        tags: {
            route: ROUTE_OF_KIND[kind],
            budget: 'report-dedupe',
            reportKind: kind,
        },
        extra: { maxKeys: maxKeysPerKind, windowMs: WINDOW_MS },
    })
}

/**
 * True when this report should be recorded: the first report of `kind` for
 * (reporter, couponId) in the window (it takes the slot), or ANY report while the
 * table is full (fail open, untracked). False only for a tracked duplicate.
 */
export function admitReport(
    kind: ReportKind,
    reporter: ReportReporter,
    couponId: string,
    now: number = Date.now(),
): boolean {
    const table = tables[kind]
    const key = keyOf(reporter, couponId)
    const expiresAt = table.expiryByKey.get(key)
    if (expiresAt !== undefined && expiresAt > now) return false

    if (
        table.expiryByKey.size >= maxKeysPerKind &&
        now - table.lastSweepAt >= SWEEP_MIN_INTERVAL_MS
    ) {
        sweepExpired(table, now)
    }
    if (table.expiryByKey.size >= maxKeysPerKind && expiresAt === undefined) {
        reportCapHit(kind, table, now)
        return true
    }
    // An expired entry for this very key is overwritten in place.
    table.expiryByKey.set(key, now + WINDOW_MS)
    return true
}

/**
 * Give an admitted report's slot back: the signal write that followed it
 * failed, so the (retrying) client must not be deduped against a report that
 * never landed.
 *
 * Known and accepted: the delete does not check WHICH request set the slot. A
 * request admitted untracked while the table was full, whose write then fails,
 * can free a slot that a later request from the same reporter took and whose
 * write did land, so one more report from that reporter would count. That needs
 * a full table plus failing writes, and costs at most one extra count per failed
 * write. The extension sends each report once and never retries.
 */
export function releaseReport(
    kind: ReportKind,
    reporter: ReportReporter,
    couponId: string,
): void {
    tables[kind].expiryByKey.delete(keyOf(reporter, couponId))
}

/** Test-only: clear every table and optionally lower the per-kind cap. */
export function resetReportDedupeForTests(
    options: { maxKeys?: number } = {},
): void {
    for (const kind of Object.keys(tables) as ReportKind[]) {
        tables[kind] = emptyTable()
    }
    maxKeysPerKind = options.maxKeys ?? DEFAULT_MAX_KEYS_PER_KIND
}
