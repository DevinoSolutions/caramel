// lib/couponSignals.ts
//
// App-owned trust telemetry for the coupon catalog (W1 of the Coupons
// Ownership Inversion + Trust Loop). This is the ONE place any
// `coupon_signals` Prisma access lives — written by POST
// /api/coupons/[id]/report (worked/failed outcomes → recordWorked/recordFailed)
// and POST /api/coupons/increment (a use → recordUsage, W4-D2) — and read back
// by attachSignals() to surface "worked Xh ago" on the web card + popup.
//
// Field ownership — each writer owns exactly ONE field, so a successful apply
// (which fires BOTH report{worked} AND increment) never double-counts:
//   recordWorked → lastWorkedAt   (last successful-apply time)
//   recordUsage  → workCount      (successful-use counter)
//   recordFailed → failCount + lastFailedAt + lastFailReason
//
// It writes ONLY our own Postgres (DATABASE_URL) via prisma. It NEVER touches
// the external read-only caramel_coupons catalog (couponsDb.ts) — the whole
// point of the trust loop is to own this signal ourselves rather than mirror
// (or mutate) the externally-owned catalog. Signals are keyed by the catalog
// coupon id as a string, matching the app's Coupon.id: string.
import prisma from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'

/**
 * The only slice of the Prisma client these writers need. Satisfied by BOTH the
 * module-level singleton and an interactive-transaction client, so a caller that
 * must write the signal atomically alongside another row — the report route's
 * signed-in attribution, which pairs a `coupon_signals` upsert with a
 * `coupon_reports` insert — passes its `tx` and gets the exact same write rather
 * than a second, independently-written copy of it.
 */
export type CouponSignalWriter = Pick<Prisma.TransactionClient, 'couponSignal'>

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

/** Extension reported this coupon failed — bump the fail counter, stamp the time + the (already-bounded) store/verifier reason. */
export async function recordFailed(
    couponId: string,
    reason?: string | null,
    client: CouponSignalWriter = prisma,
): Promise<void> {
    // `reason` is already length-bounded by the report route's zod body schema
    // (trim().max(200)); passed straight through — no second-guessing a value
    // the boundary already validated.
    await client.couponSignal.upsert({
        where: { couponId },
        create: {
            couponId,
            failCount: 1,
            lastFailedAt: new Date(),
            lastFailReason: reason ?? null,
        },
        update: {
            failCount: { increment: 1 },
            lastFailedAt: new Date(),
            lastFailReason: reason ?? null,
        },
    })
}

/**
 * Attach each coupon's app-owned `lastWorkedAt` (an ISO string, or null when
 * we hold no signal for it) via a single keyed lookup — the "merge, not SQL
 * join" boundary. The coupon rows come from the external catalog (couponsRepo,
 * unchanged); the signal comes from OUR Postgres; the two are joined here in
 * application code, never across the DB boundary. Empty-in → empty-out, so a
 * page with no coupons issues no query.
 *
 * NON-FATAL: the trust overlay is non-critical. A signal-store failure — or an
 * environment whose `coupon_signals` migration hasn't run yet — degrades to
 * no-signal (every coupon's `lastWorkedAt: null`) and is reported to Sentry; it
 * must NEVER 500 the core coupon listing this result merges into.
 */
export async function attachSignals<T extends { id: string }>(
    coupons: T[],
): Promise<(T & { lastWorkedAt: string | null })[]> {
    if (coupons.length === 0) return []

    try {
        const ids = coupons.map(coupon => coupon.id)
        const signals = await prisma.couponSignal.findMany({
            where: { couponId: { in: ids } },
            select: { couponId: true, lastWorkedAt: true },
        })
        const workedAtById = new Map(
            signals.map(
                signal => [signal.couponId, signal.lastWorkedAt] as const,
            ),
        )

        return coupons.map(coupon => ({
            ...coupon,
            lastWorkedAt: workedAtById.get(coupon.id)?.toISOString() ?? null,
        }))
    } catch (error) {
        // Trust overlay is non-critical — degrade LOUDLY (Sentry), never throw.
        Sentry.captureException(error, {
            tags: { area: 'couponSignals.attachSignals' },
        })
        console.warn(
            '[couponSignals] attachSignals failed — serving coupons without the trust overlay:',
            error,
        )
        return coupons.map(coupon => ({ ...coupon, lastWorkedAt: null }))
    }
}
