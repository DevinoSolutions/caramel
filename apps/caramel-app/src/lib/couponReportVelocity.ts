// src/lib/couponReportVelocity.ts
//
// A per-COUPON speed limit on the two trust signals that move what shoppers see:
// "worked" reports (stamp a code Verified, list it in "Codes that just worked")
// and "failed" reports (sink or collapse it). couponReportDedupe.ts limits ONE
// reporter to one report per coupon per day; this limits ALL reporters together
// to a fixed number of counted reports of each kind per coupon per hour, so a
// swarm of distinct addresses or throwaway accounts cannot move a single code
// faster than that however many identities it has.
//
// TWO BUCKETS per (kind, coupon): 'established' (an established account,
// COUPON_REPORT_MAX_PER_COUPON_PER_HOUR) and 'low' (anonymous networks and young
// accounts, the smaller COUPON_REPORT_MAX_LOW_TRUST_PER_COUPON_PER_HOUR). The
// low-trust bucket is the one a swarm can fill; keeping it apart means a swarm
// cannot use up the slots established reporters count into.
//
// Over the cap a report is ACCEPTED AND NOT COUNTED: the route answers exactly
// what it answers a deduped repeat ({ ok: true, deduped: true }), so a forger
// learns nothing about the cap and an honest client sees no error. A cap hit is
// reported to Sentry (a warning, once per coupon per kind and bucket per hour,
// and at most one event per kind per minute), which is how a swarm shows up.
//
// An honest burst costs nothing real: a fresh "worked" stamp is already inside
// the 24h Verified window, and a quorum of failures needs a handful of reports,
// well under the default.
//
// STATE: an in-memory Map, per process, like couponReportDedupe.ts. It resets on
// every deploy and restart and a multi-instance deploy gives each instance its
// own counts, so the effective cap is "per hour per process". What a restart
// does NOT reset is who has reported: the failure quorum is counted from the
// persisted coupon_signal_reporters rows (couponSignals.ts), so a restart never
// lets one reporter count twice. TODO: persist these counts too (a count over
// coupon_signal_reporters.last_at works for 'failed' and for low-trust 'worked';
// an established account's 'worked' leaves no row while a coupon has no failure
// quorum, so it needs its own source) if the app is scaled past one instance or
// a deploy-timed flood is ever seen.
//
// BOUNDED: one entry per (kind, bucket, coupon) with a counted or refused report
// in the last hour, swept lazily. A release that empties an entry deletes it, so
// probing unknown ids cannot fill the table with empty entries. At the cap a
// full table is first swept of expired entries; if it is still full the OLDEST
// entry is evicted (every entry lives exactly one window, so insertion order is
// expiry order), so the newest coupon is always tracked.
import type { ReportReporter } from '@/lib/couponReportDedupe'
import { env } from '@/lib/env'
import * as Sentry from '@sentry/nextjs'

const WINDOW_MS = 60 * 60 * 1000
const MAX_ENTRIES = 20_000
const SWEEP_MIN_INTERVAL_MS = 60 * 1000
const SENTRY_MIN_INTERVAL_MS = 60 * 1000

export type VelocityKind = 'worked' | 'failed'

/** Which bucket a reporter counts into. */
export type VelocityTier = 'established' | 'low'

/** An established account counts into the established bucket; anyone else is low-trust. */
export function velocityTierOf(reporter: ReportReporter): VelocityTier {
    return reporter.kind === 'user' && reporter.established
        ? 'established'
        : 'low'
}

function defaultCap(tier: VelocityTier): number {
    return tier === 'established'
        ? env.COUPON_REPORT_MAX_PER_COUPON_PER_HOUR
        : env.COUPON_REPORT_MAX_LOW_TRUST_PER_COUPON_PER_HOUR
}

interface Entry {
    windowEndsAt: number
    counted: number
    /** Reports refused in this window (the Sentry event carries it). */
    refused: number
}

const entries = new Map<string, Entry>()
let lastSweepAt = 0
const nextSentryAt: Record<VelocityKind, number> = { worked: 0, failed: 0 }
let nextTableFullReportAt = 0

function keyOf(kind: VelocityKind, tier: VelocityTier, couponId: string) {
    return `${kind}|${tier}|${couponId}`
}

function sweepExpired(now: number): void {
    // forEach, not for-of: the tsconfig target cannot iterate a Map.
    entries.forEach((entry, key) => {
        if (entry.windowEndsAt <= now) entries.delete(key)
    })
    lastSweepAt = now
}

function makeRoom(now: number): void {
    if (entries.size < MAX_ENTRIES) return
    if (now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS) sweepExpired(now)
    if (entries.size < MAX_ENTRIES) return
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
    if (now >= nextTableFullReportAt) {
        nextTableFullReportAt = now + WINDOW_MS
        Sentry.captureMessage(
            'coupon report velocity table is full: evicting oldest',
            {
                level: 'warning',
                tags: { budget: 'report-velocity' },
                extra: { maxEntries: MAX_ENTRIES, windowMs: WINDOW_MS },
            },
        )
    }
}

function reportVelocityCap(
    kind: VelocityKind,
    tier: VelocityTier,
    couponId: string,
    entry: Entry,
    maxPerHour: number,
    now: number,
): void {
    // First refusal of the window only (refused === 1), then globally throttled.
    if (entry.refused !== 1 || now < nextSentryAt[kind]) return
    nextSentryAt[kind] = now + SENTRY_MIN_INTERVAL_MS
    Sentry.captureMessage(
        'coupon report velocity cap hit: reports for one coupon are not being counted',
        {
            level: 'warning',
            tags: {
                route: 'coupons/report',
                budget: 'report-velocity',
                reportKind: kind,
                reporterTier: tier,
            },
            // The coupon id is catalog data, not personal data.
            extra: { couponId, maxPerHour, windowMs: WINDOW_MS },
        },
    )
}

/**
 * True when a report of `kind` for `couponId` from a reporter of `tier` may be
 * COUNTED: fewer than the bucket's hourly cap have been counted for this coupon
 * in the current window (it takes one of the slots). False when the cap is
 * spent: the caller must accept the report without counting it (and give the
 * reporter's dedupe slot back, since nothing landed).
 */
export function admitCouponReportVelocity(
    kind: VelocityKind,
    couponId: string,
    tier: VelocityTier,
    now: number = Date.now(),
    maxPerHour: number = defaultCap(tier),
): boolean {
    const key = keyOf(kind, tier, couponId)
    const entry = entries.get(key)
    if (entry && entry.windowEndsAt > now) {
        if (entry.counted >= maxPerHour) {
            entry.refused += 1
            reportVelocityCap(kind, tier, couponId, entry, maxPerHour, now)
            return false
        }
        entry.counted += 1
        return true
    }
    // A new window. Delete first so a re-taken key moves to the back: the
    // Map's insertion order must stay its expiry order for makeRoom.
    entries.delete(key)
    makeRoom(now)
    entries.set(key, { windowEndsAt: now + WINDOW_MS, counted: 1, refused: 0 })
    return true
}

/**
 * Give a counted slot back: the signal write that followed it failed or found
 * no such coupon, so the report never landed. A no-op when the window rolled.
 * An entry that is left with nothing counted and nothing refused is deleted, so
 * a prober of unknown ids cannot leave empty entries behind to fill the table.
 */
export function releaseCouponReportVelocity(
    kind: VelocityKind,
    couponId: string,
    tier: VelocityTier,
    now: number = Date.now(),
): void {
    const key = keyOf(kind, tier, couponId)
    const entry = entries.get(key)
    if (!entry || entry.windowEndsAt <= now || entry.counted <= 0) return
    entry.counted -= 1
    if (entry.counted === 0 && entry.refused === 0) entries.delete(key)
}

/** Test-only: how many entries the table holds. */
export function velocityEntryCountForTests(): number {
    return entries.size
}

/** Test-only: forget every count and throttle. */
export function resetReportVelocityForTests(): void {
    entries.clear()
    lastSweepAt = 0
    nextSentryAt.worked = 0
    nextSentryAt.failed = 0
    nextTableFullReportAt = 0
}
