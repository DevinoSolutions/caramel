// lib/couponSignals.ts
//
// App-owned trust telemetry for the coupon catalog (W1 of the Coupons
// Ownership Inversion + Trust Loop). This is the ONE place any
// `coupon_signals` Prisma access lives — written by POST
// /api/coupons/[id]/report (worked/failed outcomes → recordWorked/recordFailed)
// and POST /api/coupons/increment (a use → recordUsage, W4-D2) — and read back
// by attachSignals() to surface "Just worked" / "Worked Xh ago" on the web
// card + popup. The ONE other reader is couponsRepo.listRecentlyWorkedCoupons:
// a read-only SQL JOIN of coupon_signals onto the catalog (the landing page's
// "Codes that just worked"), which lives in couponsRepo because every
// catalog-joining query does. No other module may write this table.
//
// Field ownership — each writer owns exactly ONE field, so a successful apply
// (which fires BOTH report{worked} AND increment) never double-counts:
//   recordWorked → lastWorkedAt   (last successful-apply time)
//   recordUsage  → workCount      (successful-use counter)
//   recordFailed → failCount + failWeight + lastFailedAt + lastFailReason
//                  (+ the reporter's coupon_signal_reporters row)
//
// It writes ONLY our own Postgres (DATABASE_URL) via prisma. It NEVER touches
// the external read-only caramel_coupons catalog (couponsDb.ts) — the whole
// point of the trust loop is to own this signal ourselves rather than mirror
// (or mutate) the externally-owned catalog. Signals are keyed by the catalog
// coupon id as a string, matching the app's Coupon.id: string.
import type { ReportReporter } from '@/lib/couponReportDedupe'
import { FAILING_WINDOW_MS, keepsFailing } from '@/lib/coupons'
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'
import type { Prisma, PrismaClient } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'
import { createHmac } from 'node:crypto'

/**
 * The only slice of the Prisma client these writers need. Satisfied by BOTH the
 * module-level singleton and an interactive-transaction client, so a caller that
 * must write the signal atomically alongside another row — the report route's
 * signed-in attribution, which pairs a `coupon_signals` upsert with a
 * `coupon_reports` insert — passes its `tx` and gets the exact same write rather
 * than a second, independently-written copy of it.
 */
export type CouponSignalWriter = Pick<Prisma.TransactionClient, 'couponSignal'>

/** What recordFailed needs on top: the per-reporter rows its quorum is counted from. */
export type CouponFailureWriter = Pick<
    Prisma.TransactionClient,
    'couponSignal' | 'couponSignalReporter'
>

/**
 * How much one distinct reporter counts toward a failure quorum. A signed-in
 * account costs a verified email, an anonymous network costs a proxy address,
 * so an account counts double. coupons.ts FAILING_MIN_FAIL_WEIGHT /
 * KEEPS_FAILING_MIN_FAIL_WEIGHT are the thresholds these add up against.
 */
export const REPORTER_WEIGHT = { account: 2, network: 1 } as const

/**
 * The reporter as stored in coupon_signal_reporters: an HMAC-SHA256 of its
 * identity under the app's auth secret (the same secret env.ts already forces
 * to exist), so the table holds no raw IP or user id and a leaked copy cannot
 * be reversed by trying every IPv4 address. 32 hex chars (128 bits) is plenty
 * to tell reporters of one coupon apart.
 */
export function reporterHash(reporter: ReportReporter): string {
    const secret = env.BETTER_AUTH_SECRET ?? env.JWT_SECRET
    if (!secret) {
        // env.ts's refine() makes this unreachable; a loud throw beats hashing
        // under an empty key if that ever changes.
        throw new Error('reporterHash: no BETTER_AUTH_SECRET or JWT_SECRET')
    }
    const identity =
        reporter.kind === 'user' ? `u:${reporter.userId}` : `i:${reporter.ip}`
    return createHmac('sha256', secret)
        .update(`coupon-signal-reporter:${identity}`)
        .digest('hex')
        .slice(0, 32)
}

/** A reporter's weight toward a failure quorum. */
export function reporterWeight(reporter: ReportReporter): number {
    return reporter.kind === 'user'
        ? REPORTER_WEIGHT.account
        : REPORTER_WEIGHT.network
}

/**
 * Extension reported this coupon worked at checkout — stamp the last-worked
 * time. Deliberately does NOT bump workCount: a successful apply ALSO fires
 * POST /api/coupons/increment (→ recordUsage), which owns the counter, so
 * bumping it here too would double-count every success. This writer owns
 * `lastWorkedAt` only.
 */
export async function recordWorked(
    couponId: string,
    client: CouponSignalWriter = prisma,
): Promise<void> {
    await client.couponSignal.upsert({
        where: { couponId },
        create: { couponId, lastWorkedAt: new Date() },
        update: { lastWorkedAt: new Date() },
    })
}

/**
 * A coupon was USED — the extension applied it and POST /api/coupons/increment
 * fired (W4-D2). Bump the app-owned usage counter. NO timestamp: a use is not a
 * trust "worked-at" stamp (recordWorked owns `lastWorkedAt`). This REPLACES the
 * old external `coupons.times_used` UPDATE (RULING C′): touching the external
 * catalog would bump its `updated_at` and, under the ingest only-if-newer rule
 * (`excluded.updated_at >= coupons.updated_at`), freeze every future pipeline
 * push for that row. Keyed by coupon id independently of catalog-row existence,
 * so the upsert always succeeds. This writer owns `workCount` only.
 */
export async function recordUsage(couponId: string): Promise<void> {
    await prisma.couponSignal.upsert({
        where: { couponId },
        create: { couponId, workCount: 1 },
        update: { workCount: { increment: 1 } },
    })
}

/**
 * A reporter said this coupon failed. Records, in ONE transaction (a singleton
 * client is wrapped, a transaction client is joined):
 *   1. the reporter's coupon_signal_reporters row (one per distinct reporter,
 *      re-stamped when the same reporter reports again after the dedupe window);
 *   2. the aggregate: failCount (raw count), lastFailedAt, the (already
 *      bounded) store/verifier reason;
 *   3. failWeight, recomputed as the sum of the weights of the DISTINCT
 *      reporters whose failure is newer than the last success and inside
 *      FAILING_WINDOW_MS. This is what sinks and collapses a code, not
 *      failCount: three forged anonymous reports are three reporters of weight
 *      1 and stay under FAILING_MIN_FAIL_WEIGHT.
 * Reporters older than the window are pruned on the way. Two concurrent first
 * reports can each recompute without seeing the other's row (read committed);
 * the weight then under-counts until the next report, which errs toward not
 * sinking a code.
 */
export async function recordFailed(
    couponId: string,
    reason: string | null | undefined,
    reporter: ReportReporter,
    client: CouponFailureWriter | PrismaClient = prisma,
): Promise<void> {
    if ('$transaction' in client) {
        await client.$transaction(tx =>
            recordFailedIn(couponId, reason ?? null, reporter, tx),
        )
        return
    }
    await recordFailedIn(couponId, reason ?? null, reporter, client)
}

async function recordFailedIn(
    couponId: string,
    reason: string | null,
    reporter: ReportReporter,
    tx: CouponFailureWriter,
): Promise<void> {
    const now = new Date()
    const hash = reporterHash(reporter)
    const weight = reporterWeight(reporter)
    await tx.couponSignalReporter.upsert({
        where: {
            couponId_outcome_reporterHash: {
                couponId,
                outcome: 'failed',
                reporterHash: hash,
            },
        },
        create: {
            couponId,
            outcome: 'failed',
            reporterHash: hash,
            weight,
            lastAt: now,
        },
        update: { weight, lastAt: now },
    })
    // `reason` is already length-bounded by the report route's zod body schema
    // (trim().max(200)); passed straight through — no second-guessing a value
    // the boundary already validated.
    const signal = await tx.couponSignal.upsert({
        where: { couponId },
        create: {
            couponId,
            failCount: 1,
            lastFailedAt: now,
            lastFailReason: reason,
        },
        update: {
            failCount: { increment: 1 },
            lastFailedAt: now,
            lastFailReason: reason,
        },
        select: { lastWorkedAt: true },
    })
    const windowStart = new Date(now.getTime() - FAILING_WINDOW_MS)
    const since =
        signal.lastWorkedAt && signal.lastWorkedAt > windowStart
            ? signal.lastWorkedAt
            : windowStart
    const total = await tx.couponSignalReporter.aggregate({
        where: { couponId, outcome: 'failed', lastAt: { gt: since } },
        _sum: { weight: true },
    })
    await tx.couponSignal.update({
        where: { couponId },
        data: { failWeight: total._sum.weight ?? 0 },
    })
    await tx.couponSignalReporter.deleteMany({
        where: { couponId, outcome: 'failed', lastAt: { lt: windowStart } },
    })
}

/** The trust overlay attachSignals merges onto each coupon (ISO strings; null/0 when we hold no signal). */
export type CouponSignalOverlay = {
    lastWorkedAt: string | null
    lastFailedAt: string | null
    failCount: number
    /** The failure quorum (coupon_signals.fail_weight) isRecentlyFailing / keepsFailing read; the card evaluates isRecentlyFailing client-side over this. */
    failWeight: number
    /** coupons.ts keepsFailing(), decided server-side so the popup and the web agree. */
    keepsFailing: boolean
}

const NO_SIGNAL: CouponSignalOverlay = {
    lastWorkedAt: null,
    lastFailedAt: null,
    failCount: 0,
    failWeight: 0,
    keepsFailing: false,
}

/**
 * Attach each coupon's app-owned trust overlay — `lastWorkedAt` and
 * `lastFailedAt` (ISO strings, or null when we hold no signal for it) plus
 * `failCount` and the derived `keepsFailing` flag — via a single keyed lookup, the "merge, not SQL join" boundary.
 * The coupon rows come from the catalog (couponsRepo, unchanged); the signal
 * comes from `coupon_signals`; the two are merged here in application code.
 * `lastFailReason` is deliberately NOT attached: it is free text a client
 * supplied and nothing renders it. Empty-in → empty-out, so a page with no
 * coupons issues no query.
 *
 * This only DECORATES the page a listing already picked. The ORDER of a store's
 * list (recently-failing codes sink, coupons.ts isRecentlyFailing) is decided in
 * SQL by couponsRepo.failingSinkSql(): the list is paginated, so a sort here
 * could only reorder the page it was handed.
 *
 * NON-FATAL: the trust overlay is non-critical. A signal-store failure — or an
 * environment whose `coupon_signals` migration hasn't run yet — degrades to
 * no-signal (every coupon's `lastWorkedAt: null`) and is reported to Sentry; it
 * must NEVER 500 the core coupon listing this result merges into.
 */
export async function attachSignals<T extends { id: string }>(
    coupons: T[],
): Promise<(T & CouponSignalOverlay)[]> {
    if (coupons.length === 0) return []

    try {
        const ids = coupons.map(coupon => coupon.id)
        const signals = await prisma.couponSignal.findMany({
            where: { couponId: { in: ids } },
            select: {
                couponId: true,
                lastWorkedAt: true,
                lastFailedAt: true,
                failCount: true,
                failWeight: true,
            },
        })
        const signalById = new Map(
            signals.map(signal => [signal.couponId, signal] as const),
        )

        return coupons.map(coupon => {
            const signal = signalById.get(coupon.id)
            return {
                ...coupon,
                lastWorkedAt: signal?.lastWorkedAt?.toISOString() ?? null,
                lastFailedAt: signal?.lastFailedAt?.toISOString() ?? null,
                failCount: signal?.failCount ?? 0,
                failWeight: signal?.failWeight ?? 0,
                keepsFailing: signal ? keepsFailing(signal) : false,
            }
        })
    } catch (error) {
        // Trust overlay is non-critical — degrade LOUDLY (Sentry), never throw.
        Sentry.captureException(error, {
            tags: { area: 'couponSignals.attachSignals' },
        })
        console.warn(
            '[couponSignals] attachSignals failed — serving coupons without the trust overlay:',
            error,
        )
        return coupons.map(coupon => ({ ...coupon, ...NO_SIGNAL }))
    }
}
