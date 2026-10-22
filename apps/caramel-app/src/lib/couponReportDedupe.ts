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
// The reporter is the signed-in USER when there is a session and the client
// network (the IP, an IPv6 one cut to its /64) only for anonymous callers: two
// users behind one NAT must each keep their own report (and their coupon_reports
// attribution row). Two ANONYMOUS shoppers behind one IP, or one IPv6 /64, share
// a slot per coupon per kind: the second one's repeat of the same report within
// 24h is not counted.
//
// STATE: an in-memory Map<key, expiry>, per process. It resets on every deploy
// and restart (a reporter can re-report once after one), and a multi-instance
// deploy would give each instance its own window. TODO: move to a shared store
// if the app is ever scaled past one instance (same stance as rateLimit.ts and
// classifyCartModelBudget.ts).
//
// BOUNDED: a Map entry per (reporter, coupon) must not grow without limit across
// rotating addresses and coupon ids, because this app has had memory/slowness
// outages. There are no per-key timers: entries are plain expiries, swept
// lazily. At the cap the dedupe NEVER switches off: a full table is first swept
// of expired keys, and if it is still full the OLDEST tracked key is evicted to
// make room, so the newest reporter is always tracked and no honest report is
// ever refused. Every key lives exactly WINDOW_MS, so the Map's insertion order
// is also its expiry order and the first key is the oldest. The cost: a flood of
// 50k fresh keys inside one window can push an older reporter's slot out, which
// lets that one reporter count once more. That takes 50k distinct reporter and
// coupon pairs inside 24h, each past the per-IP rate limit, so it is accepted
// (the old behaviour, accepting every report untracked once full, gave a forger
// no throttle at all). One throttled Sentry warning per hour per kind says the
// cap is being hit.
//
// ONE TABLE PER KIND, each with its own cap. Every successful apply sends a
// 'worked' report and a use, so honest success traffic is the bulk of the keys;
// in one shared table it could fill the cap and switch off the 'failed' dedupe,
// which is the one that stops a code being flagged by a single reporter.
import { readEdgeClientIp } from '@/lib/clientIp'
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
    { kind: 'user'; userId: string } | { kind: 'ip'; ip: string }

/**
 * The one anonymous reporter every request WITHOUT the Cloudflare edge header
 * counts as. Such a request reached the app around the edge (direct origin
 * hit, local dev, e2e), so its X-Real-IP / X-Forwarded-For are client input
 * and must not mint identities: forging them would otherwise make as many
 * "distinct reporters" as the caller likes. Collapsing them into one is the
 * safe direction (they can never reach a quorum alone); the cost is that an
 * environment with no Cloudflare in front sees all its anonymous shoppers as a
 * single reporter. To exercise distinct anonymous reporters locally, send
 * CF-Connecting-IP yourself.
 */
export const NO_EDGE_REPORTER_NETWORK = 'no-edge-header'

/**
 * The reporter a request counts as: its signed-in user, else its client
 * network (the Cloudflare edge address, readEdgeClientIp, with an IPv6 address
 * cut to its /64; NO_EDGE_REPORTER_NETWORK when the edge header is absent).
 * Both report routes call this, so a shopper is one reporter on both. This is
 * deliberately NOT getClientIp (the rate limiter's key): the limiter may fall
 * back to forgeable headers, an identity that decides what other shoppers see
 * may not.
 */
export function reporterFor(
    userId: string | null,
    req: NextRequest,
): ReportReporter {
    if (userId) return { kind: 'user', userId }
    const edgeIp = readEdgeClientIp(req.headers)
    return {
        kind: 'ip',
        ip: edgeIp ? reporterNetwork(edgeIp) : NO_EDGE_REPORTER_NETWORK,
    }
}

/**
 * An IPv4 address as it is; an IPv6 address as its /64, the block one home or
 * phone connection is handed whole. Keyed per address, a shopper on IPv6
 * could pick a new address from that block for each report and count as a
 * new reporter every time. An IPv4-mapped IPv6 address is its IPv4 address.
 * Anything that does not parse as IPv6 is returned unchanged.
 */
export function reporterNetwork(ip: string): string {
    if (!ip.includes(':')) return ip
    const bare = ip.split('%')[0].toLowerCase()
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
    if (mapped) return mapped[1]
    const halves = bare.split('::')
    if (halves.length > 2) return ip
    const groups = (s: string) => (s ? s.split(':') : [])
    const head = groups(halves[0])
    const tail = halves.length === 2 ? groups(halves[1]) : []
    // An IPv4 tail ("64:ff9b::1.2.3.4") is two groups; it never reaches the
    // first four, so it only has to be counted.
    const width = (g: string[]) =>
        g.reduce((n, part) => n + (part.includes('.') ? 2 : 1), 0)
    const missing = 8 - width(head) - width(tail)
    if (halves.length === 1 ? missing !== 0 : missing < 1) return ip
    const full = [...head, ...Array<string>(missing).fill('0'), ...tail]
    const prefix = full.slice(0, 4)
    if (!prefix.every(part => /^[0-9a-f]{1,4}$/.test(part))) return ip
    return prefix.map(part => part.replace(/^0+(?=.)/, '')).join(':') + '::/64'
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

/** Drop the first (oldest-inserted, soonest-expiring) key. */
function evictOldest(table: KindTable): void {
    const oldest = table.expiryByKey.keys().next()
    if (!oldest.done) table.expiryByKey.delete(oldest.value)
}

function reportCapHit(kind: ReportKind, table: KindTable, now: number): void {
    if (now < table.nextCapReportAt) return
    table.nextCapReportAt = now + CAP_REPORT_INTERVAL_MS
    Sentry.captureMessage(
        'coupon report dedupe table is full: evicting oldest',
        {
            level: 'warning',
            tags: {
                route: ROUTE_OF_KIND[kind],
                budget: 'report-dedupe',
                reportKind: kind,
            },
            extra: { maxKeys: maxKeysPerKind, windowMs: WINDOW_MS },
        },
    )
}

/**
 * True when this report should be recorded: the first report of `kind` for
 * (reporter, couponId) in the window (it takes the slot, evicting the oldest
 * tracked key when the table is full). False only for a tracked duplicate.
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
        evictOldest(table)
        reportCapHit(kind, table, now)
    }
    // Delete first so a re-taken (expired) key moves to the back: the Map's
    // insertion order must stay its expiry order for evictOldest.
    table.expiryByKey.delete(key)
    table.expiryByKey.set(key, now + WINDOW_MS)
    return true
}

/**
 * Give an admitted report's slot back: the signal write that followed it
 * failed, so the (retrying) client must not be deduped against a report that
 * never landed.
 *
 * Known and accepted: the delete does not check WHICH request set the slot. A
 * slot can have been evicted and re-taken by a later request from the same
 * reporter whose write did land; freeing it then lets one more report from that
 * reporter count. That needs a full table plus failing writes, and costs at most
 * one extra count per failed write. The extension sends each report once and
 * never retries.
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
