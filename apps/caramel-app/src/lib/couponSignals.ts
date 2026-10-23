// lib/couponSignals.ts
//
// App-owned trust telemetry for the coupon catalog (W1 of the Coupons
// Ownership Inversion + Trust Loop). This is the ONE place any
// `coupon_signals` Prisma access lives — written by POST
// /api/coupons/[id]/report (worked/failed outcomes → recordWorked/recordFailed)
// and POST /api/coupons/increment (a use → recordUsage, W4-D2) — and read back
// by attachSignals() to surface "Just worked" / "Worked Xh ago" on the web
// card + popup. The aggregate row's upsert is the one statement couponsRepo
// owns (writeWorkedSignal / writeFailedSignal / writeUsageSignal: an INSERT ...
// SELECT ... WHERE EXISTS (catalog row) ON CONFLICT, so the unknown-coupon
// check and the write are one round trip); this module calls it and owns the
// per-reporter quorum rows around it. The ONE other reader is
// couponsRepo.listRecentlyWorkedCoupons:
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
import {
    FAILING_WINDOW_MS,
    MAX_LOW_TRUST_FAIL_WEIGHT,
    WORKED_VERIFIED_WINDOW_MS,
    keepsFailing,
} from '@/lib/coupons'
import {
    writeFailedSignal,
    writeUsageSignal,
    writeWorkedSignal,
} from '@/lib/couponsRepo'
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'
import type { Prisma, PrismaClient } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'
import { createHmac } from 'node:crypto'

/**
 * The only slice of the Prisma client the signal writers need. Satisfied by an
 * interactive-transaction client, so a caller that must write the signal
 * atomically alongside another row (the report route's signed-in attribution,
 * which pairs the coupon_signals writes with a `coupon_reports` insert) passes
 * its `tx` and gets the exact same write rather than an independent copy of it.
 * Both writers also accept the singleton client and then open their own
 * transaction. `$queryRaw` carries the aggregate upsert
 * (couponsRepo.writeWorkedSignal / writeFailedSignal, one statement that is also
 * the catalog existence gate); the two models are the per-reporter rows the
 * failure quorum is counted from.
 */
export type CouponFailureWriter = Pick<
    Prisma.TransactionClient,
    '$queryRaw' | 'couponSignal' | 'couponSignalReporter'
>

/**
 * How much one distinct reporter counts toward a failure quorum. An ESTABLISHED
 * signed-in account (accountReputation.ts: it has existed for a while) counts
 * double an anonymous network. A signed-in account that is still young costs
 * only a verified email, which is as cheap as a proxy address, so it counts as
 * a network. coupons.ts FAILING_MIN_FAIL_WEIGHT / KEEPS_FAILING_MIN_FAIL_WEIGHT
 * are the thresholds these add up against, and MAX_LOW_TRUST_FAIL_WEIGHT caps
 * the weight-`network` reporters together (recomputeFailWeight).
 */
export const REPORTER_WEIGHT = { account: 2, network: 1 } as const

/** Domain separator: the auth secret is never used raw for a second purpose. */
const REPORTER_KEY_DOMAIN = 'caramel:coupon-reporter:v1'

/**
 * The reporter as stored in coupon_signal_reporters: an HMAC-SHA256 of its
 * identity under a key DERIVED from the app's auth secret
 * (HMAC(secret, REPORTER_KEY_DOMAIN); env.ts already forces the secret to
 * exist), so the table holds no raw IP or user id and a leaked copy cannot be
 * reversed by trying every IPv4 address. 32 hex chars (128 bits) is plenty to
 * tell reporters of one coupon apart. Rotating the auth secret changes every
 * hash, which only resets reporter identities (each reporter counts afresh):
 * acceptable.
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
    const key = createHmac('sha256', secret)
        .update(REPORTER_KEY_DOMAIN)
        .digest()
    return createHmac('sha256', key).update(identity).digest('hex').slice(0, 32)
}

/** A reporter's weight toward a failure quorum. */
export function reporterWeight(reporter: ReportReporter): number {
    return reporter.kind === 'user' && reporter.established
        ? REPORTER_WEIGHT.account
        : REPORTER_WEIGHT.network
}

/**
 * A success needs a QUORUM of its own to clear failure reports: the failure
 * rows older than a success stop counting only once the distinct reporters who
 * reported a success AFTER them weigh at least this much (one signed-in account,
 * or two anonymous networks). One anonymous "worked" must not wipe the failure
 * quorum, or one forged success would undo any number of honest failures.
 * Matches the T-4372 "2 distinct reporters" rule.
 */
export const CLEARING_WORKED_WEIGHT = 2

/**
 * Most clearing weight the LOW-TRUST reporters (anonymous networks, young
 * accounts) can add together, the mirror of coupons.ts MAX_LOW_TRUST_FAIL_WEIGHT:
 * one below CLEARING_WORKED_WEIGHT, so no number of them clears a failure quorum
 * and only an established account's success does. Without it two forged
 * anonymous successes would undo a quorum of honest failures.
 */
export const MAX_LOW_TRUST_CLEARING_WEIGHT = CLEARING_WORKED_WEIGHT - 1

/**
 * Recompute coupon_signals.fail_weight for a coupon from its reporter rows:
 * the sum of the weights of the DISTINCT reporters whose failure is inside
 * FAILING_WINDOW_MS and is not cleared by a worked quorum (CLEARING_WORKED_WEIGHT)
 * reported at or after it. Called by both writers, inside their transaction and
 * AFTER the coupon_signals upsert, so the upsert's row lock has serialised
 * concurrent reports of the coupon and this read sees every committed reporter
 * row (read committed takes a fresh snapshot per statement): no report can be
 * under-counted.
 */
async function recomputeFailWeight(
    tx: CouponFailureWriter,
    couponId: string,
    now: Date,
): Promise<void> {
    const windowStart = new Date(now.getTime() - FAILING_WINDOW_MS)
    const rows = await tx.couponSignalReporter.findMany({
        where: { couponId, lastAt: { gt: windowStart } },
        select: { outcome: true, weight: true, lastAt: true },
    })
    const worked = rows.filter(row => row.outcome === 'worked')
    // Reporters at the account weight (or above: the 'legacy' seed rows weigh
    // 2, 4 or 6) count in full. The weight-`network` reporters (anonymous
    // networks, young accounts) are cheap to mint, so together they stop at
    // MAX_LOW_TRUST_FAIL_WEIGHT: below the sink threshold, so a code can never
    // be sunk without an established account behind it.
    let trusted = 0
    let lowTrust = 0
    for (const failure of rows) {
        if (failure.outcome !== 'failed') continue
        let trustedClearing = 0
        let lowTrustClearing = 0
        for (const success of worked) {
            if (success.lastAt < failure.lastAt) continue
            if (success.weight >= REPORTER_WEIGHT.account) {
                trustedClearing += success.weight
            } else {
                lowTrustClearing += success.weight
            }
        }
        const clearing =
            trustedClearing +
            Math.min(lowTrustClearing, MAX_LOW_TRUST_CLEARING_WEIGHT)
        if (clearing >= CLEARING_WORKED_WEIGHT) continue
        if (failure.weight >= REPORTER_WEIGHT.account) trusted += failure.weight
        else lowTrust += failure.weight
    }
    await tx.couponSignal.update({
        where: { couponId },
        data: {
            failWeight: trusted + Math.min(lowTrust, MAX_LOW_TRUST_FAIL_WEIGHT),
        },
    })
}

/**
 * A reporter said this coupon worked at checkout. Whether that moves
 * `lastWorkedAt` (the "Verified"/"just worked" stamp, which also lists the code
 * in "Codes that just worked") depends on WHO says so, because the request is
 * client-asserted and cheap to forge:
 *   - an ESTABLISHED account (reporter.established), or a caller that already
 *     vetted the shopper and passes `options.forceStamp` (the checkout capture,
 *     checkoutWorkedStamp.ts), stamps on its own say-so;
 *   - a LOW-TRUST reporter (anonymous network, young account) stamps only once
 *     COUPON_WORKED_QUORUM_LOW_TRUST_REPORTERS DISTINCT low-trust reporters have
 *     said so within WORKED_VERIFIED_WINDOW_MS. Their reports are kept in
 *     coupon_signal_reporters (as 'worked' rows, hashed like every reporter) so
 *     the quorum survives a restart; before the quorum a low-trust report
 *     leaves `lastWorkedAt` exactly as it was.
 * Deliberately does NOT bump workCount: a successful apply ALSO fires POST
 * /api/coupons/increment (→ recordUsage), which owns the counter. When the
 * coupon carries a live failure quorum (fail_weight > 0) the reporter's success
 * is also recorded and the quorum recomputed, so a success clears failures only
 * once enough weight of distinct reporters agree (low-trust ones count up to
 * MAX_LOW_TRUST_CLEARING_WEIGHT together). One transaction (a singleton client
 * is wrapped, a transaction client is joined).
 *
 * Resolves true when the coupon exists, false when `couponId` is not a catalog
 * row (couponsRepo.writeWorkedSignal folds that existence check into its single
 * upsert statement): nothing was written, and the caller owns the
 * unknown-coupon response. True does NOT say the stamp moved: a low-trust
 * report short of the quorum is accepted and not stamped, and the caller
 * answers it exactly like any other.
 */
export async function recordWorked(
    couponId: string,
    reporter: ReportReporter,
    client: CouponFailureWriter | PrismaClient = prisma,
    options: { forceStamp?: boolean } = {},
): Promise<boolean> {
    const forceStamp = options.forceStamp === true
    if ('$transaction' in client) {
        return client.$transaction(tx =>
            recordWorkedIn(couponId, reporter, tx, forceStamp),
        )
    }
    return recordWorkedIn(couponId, reporter, client, forceStamp)
}

async function recordWorkedIn(
    couponId: string,
    reporter: ReportReporter,
    tx: CouponFailureWriter,
    forceStamp: boolean,
): Promise<boolean> {
    const now = new Date()
    const lowTrust =
        !forceStamp && !(reporter.kind === 'user' && reporter.established)
    const signal = await writeWorkedSignal(couponId, tx, { stamp: !lowTrust })
    if (!signal) return false
    const hash = reporterHash(reporter)
    const weight = reporterWeight(reporter)
    const upsertReporterRow = () =>
        tx.couponSignalReporter.upsert({
            where: {
                couponId_outcome_reporterHash: {
                    couponId,
                    outcome: 'worked',
                    reporterHash: hash,
                },
            },
            create: {
                couponId,
                outcome: 'worked',
                reporterHash: hash,
                weight,
                lastAt: now,
            },
            update: { weight, lastAt: now },
        })
    if (lowTrust) {
        await upsertReporterRow()
        const distinct = await tx.couponSignalReporter.count({
            where: {
                couponId,
                outcome: 'worked',
                weight: { lt: REPORTER_WEIGHT.account },
                lastAt: {
                    gt: new Date(now.getTime() - WORKED_VERIFIED_WINDOW_MS),
                },
            },
        })
        if (distinct >= env.COUPON_WORKED_QUORUM_LOW_TRUST_REPORTERS) {
            await writeWorkedSignal(couponId, tx, { stamp: true })
        }
    } else {
        // An established reporter's success is only remembered while the coupon
        // carries a failure quorum it can clear: a coupon with no failures
        // stores nothing about the reporter.
        if (signal.failWeight <= 0) return true
        await upsertReporterRow()
    }
    if (signal.failWeight > 0) await recomputeFailWeight(tx, couponId, now)
    return true
}

/**
 * A coupon was USED — the extension applied it and POST /api/coupons/increment
 * fired (W4-D2). Bump the app-owned usage counter. NO timestamp: a use is not a
 * trust "worked-at" stamp (recordWorked owns `lastWorkedAt`). This REPLACES the
 * old external `coupons.times_used` UPDATE (RULING C′): touching the external
 * catalog would bump its `updated_at` and, under the ingest only-if-newer rule
 * (`excluded.updated_at >= coupons.updated_at`), freeze every future pipeline
 * push for that row. Keyed by coupon id with no FK to the catalog, so the
 * existence gate is part of the write itself (see the true/false result below).
 * This writer owns `workCount` only.
 *
 * Resolves true when the use was counted, false when `couponId` is not a
 * catalog row (couponsRepo.writeUsageSignal folds that existence check into
 * its single upsert statement): nothing was written, and the caller owns the
 * unknown-coupon response.
 */
export async function recordUsage(couponId: string): Promise<boolean> {
    return (await writeUsageSignal(couponId)) !== null
}

/**
 * A reporter said this coupon failed. Records, in ONE transaction (a singleton
 * client is wrapped, a transaction client is joined):
 *   1. the reporter's coupon_signal_reporters row (one per distinct reporter,
 *      re-stamped when the same reporter reports again after the dedupe window);
 *   2. the aggregate: failCount (raw count), lastFailedAt, the (already
 *      bounded) store/verifier reason;
 *   3. failWeight, recomputed by recomputeFailWeight: the sum of the weights of
 *      the DISTINCT reporters whose failure is inside FAILING_WINDOW_MS and not
 *      cleared by a worked quorum. This is what sinks and collapses a code, not
 *      failCount: three forged anonymous reports are three reporters of weight
 *      1 and stay under FAILING_MIN_FAIL_WEIGHT.
 * Reporters older than the window are pruned for THIS coupon on the way; the
 * global retention sweep (sweepExpiredReporters) runs outside the transaction.
 * Concurrent reports of one coupon serialise on the coupon_signals upsert's row
 * lock, so the recompute that follows sees all of them (see recomputeFailWeight).
 *
 * Resolves true when the failure was recorded, false when `couponId` is not a
 * catalog row (couponsRepo.writeFailedSignal folds that existence check into
 * its single upsert statement): nothing was written, no reporter row included,
 * and the caller owns the unknown-coupon response.
 */
export async function recordFailed(
    couponId: string,
    reason: string | null | undefined,
    reporter: ReportReporter,
    client: CouponFailureWriter | PrismaClient = prisma,
): Promise<boolean> {
    if ('$transaction' in client) {
        return client.$transaction(tx =>
            recordFailedIn(couponId, reason ?? null, reporter, tx),
        )
    }
    return recordFailedIn(couponId, reason ?? null, reporter, client)
}

async function recordFailedIn(
    couponId: string,
    reason: string | null,
    reporter: ReportReporter,
    tx: CouponFailureWriter,
): Promise<boolean> {
    const now = new Date()
    const hash = reporterHash(reporter)
    const weight = reporterWeight(reporter)
    // `reason` is already length-bounded by the report route's zod body schema
    // (trim().max(200)); passed straight through — no second-guessing a value
    // the boundary already validated.
    // The aggregate upsert comes FIRST: its row lock serialises concurrent
    // reports of this coupon before the quorum is recomputed. It is also the
    // catalog existence gate: an unknown id writes nothing (reporter row
    // included) and the whole report is refused.
    if (!(await writeFailedSignal(couponId, reason, tx))) return false
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
    await recomputeFailWeight(tx, couponId, now)
    await tx.couponSignalReporter.deleteMany({
        where: {
            couponId,
            lastAt: { lt: new Date(now.getTime() - FAILING_WINDOW_MS) },
        },
    })
    return true
}

/** A global retention sweep runs at most this often per process. */
const REPORTER_SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** After a FAILED or timed-out sweep the next unforced try waits this long. */
const REPORTER_SWEEP_BACKOFF_MS = 5 * 60 * 1000
/** A sweep that has not settled by now is reported and abandoned. */
const REPORTER_SWEEP_TIMEOUT_MS = 60 * 1000
const REPORTER_SWEEP_AREA = 'couponSignals.sweepExpiredReporters'
let nextReporterSweepAt = 0
let reporterSweepInFlight: Promise<void> | null = null
// The DELETE of a timed-out sweep, still running in Postgres. While it is set
// NO caller (force included) starts another one, so at most one DELETE is ever
// alive per module instance and the pool cannot fill with abandoned ones.
let abandonedDeletion: Promise<void> | null = null

/**
 * Retention: reporter rows are pseudonymous IP/user-derived data and are kept
 * only for FAILING_WINDOW_MS (30 days), which the privacy policy promises.
 * recordFailed prunes the coupon it writes, but a coupon nobody reports again
 * would keep its rows, so two callers run this global sweep: the report route
 * after its write has committed (not awaited: the response never waits for
 * retention), and the hourly timer in couponReporterRetention.ts, which keeps
 * the promise true in quiet periods. One DELETE, at most hourly per process,
 * and at most ONE in flight: while a sweep is running, every other caller gets
 * the running sweep's promise instead of starting its own DELETE
 * (single-flight is per module instance, so per bundle that loads this file).
 * It is deliberately outside the report's transaction (a retention failure
 * must not roll back a report that was valid) and it never rejects. A failure
 * is captured to Sentry and logged loudly and the next unforced try waits 5
 * minutes, so a persistent failure costs one attempt per 5 minutes, not one
 * per report. A DELETE that has not settled after 60 s is reported to Sentry
 * (tagged timeout), abandoned and backed off the same way, but it keeps running
 * in Postgres, so until it settles NO caller (force included) starts another
 * DELETE; a late rejection is reported too (tagged late). `force` skips the
 * throttle and the backoff (the timer's own hourly cadence is the throttle
 * there).
 */
export function sweepExpiredReporters(
    options: { force?: boolean } = {},
): Promise<void> {
    if (abandonedDeletion) return Promise.resolve()
    if (reporterSweepInFlight) return reporterSweepInFlight
    const now = new Date()
    if (!options.force && now.getTime() < nextReporterSweepAt) {
        return Promise.resolve()
    }
    const sweep = runReporterSweep(now).finally(() => {
        reporterSweepInFlight = null
    })
    reporterSweepInFlight = sweep
    return sweep
}

async function runReporterSweep(now: Date): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
        const deletion = prisma.couponSignalReporter.deleteMany({
            where: {
                lastAt: { lt: new Date(now.getTime() - FAILING_WINDOW_MS) },
            },
        })
        const timedOut = new Promise<'timeout'>(resolve => {
            timeoutHandle = setTimeout(
                () => resolve('timeout'),
                REPORTER_SWEEP_TIMEOUT_MS,
            )
        })
        const outcome = await Promise.race([deletion, timedOut])
        if (outcome === 'timeout') {
            const error = new Error(
                `reporter retention sweep did not settle within ${REPORTER_SWEEP_TIMEOUT_MS} ms`,
            )
            Sentry.captureException(error, {
                tags: { area: REPORTER_SWEEP_AREA, timeout: 'true' },
            })
            console.error('[couponSignals]', error.message)
            abandonedDeletion = deletion
                .then(
                    () => undefined,
                    (late: unknown) => {
                        Sentry.captureException(late, {
                            tags: { area: REPORTER_SWEEP_AREA, late: 'true' },
                        })
                    },
                )
                .finally(() => {
                    abandonedDeletion = null
                })
            nextReporterSweepAt = now.getTime() + REPORTER_SWEEP_BACKOFF_MS
            return
        }
        nextReporterSweepAt = now.getTime() + REPORTER_SWEEP_INTERVAL_MS
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: REPORTER_SWEEP_AREA },
        })
        console.error(
            '[couponSignals] reporter retention sweep failed (retrying in 5 minutes):',
            error,
        )
        nextReporterSweepAt = now.getTime() + REPORTER_SWEEP_BACKOFF_MS
    } finally {
        clearTimeout(timeoutHandle)
    }
}

/** Test-only: make the next sweepExpiredReporters call run. */
export function resetReporterSweepForTests(): void {
    nextReporterSweepAt = 0
    reporterSweepInFlight = null
    abandonedDeletion = null
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
