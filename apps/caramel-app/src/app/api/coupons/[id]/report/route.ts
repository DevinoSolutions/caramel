import { isEstablishedAccount } from '@/lib/accountReputation'
import { withRoute } from '@/lib/api/withRoute'
import {
    admitReport,
    releaseReport,
    reporterFor,
} from '@/lib/couponReportDedupe'
import {
    admitCouponReportVelocity,
    releaseCouponReportVelocity,
    velocityTierOf,
} from '@/lib/couponReportVelocity'
import {
    recordFailed,
    recordWorked,
    sweepExpiredReporters,
    type CouponFailureWriter,
} from '@/lib/couponSignals'
import prisma from '@/lib/prisma'
import type { PrismaClient } from '@prisma/client'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/coupons/[id]/report — the extension's "did this coupon work?"
// trust signal (W2 will send the reports; W1 ships the endpoint + rendering,
// so signals stay empty until then and "worked Xh ago" simply doesn't render).
// Mirrors coupons/increment/route.ts exactly: POST (never a cacheable GET) so
// a mutation can't ride a browser/CDN prefetch, origin-gated + rate-limited
// via withRoute, and — like increment — NO CORS / NO OPTIONS export: the MV3
// extension fetches with host_permissions, so its request bypasses CORS
// entirely (adding CORS/OPTIONS here would be dead ceremony).
//
// An id that is not a row of the catalog is a 404 and writes nothing. The check
// is part of the aggregate write itself (couponsRepo.writeCouponSignal: an
// INSERT ... SELECT ... WHERE EXISTS statement, status-agnostic, see its doc
// comment), so a known id costs ONE statement, not an existence lookup plus a
// write. coupon_signals carries no FK, so without the gate any numeric id
// minted a signal row.
//
// Writes ONLY app-owned tables — the aggregate `coupon_signals` (through
// couponSignals.ts) and, for a signed-in caller, the attributed
// `coupon_reports` row. NEVER the external read-only coupons catalog.
//
// This is the ONE place the worked/failed vocabulary is declared; coupon_reports
// stores `outcome` as an open string precisely so this schema stays its single
// source of truth.
const ReportBodySchema = z.object({
    outcome: z.enum(['worked', 'failed']),
    // Optional free-text a store/verifier attached to a failure. Bounded here
    // (trim + max 200) so recordFailed can pass it straight through.
    storeReason: z.string().trim().max(200).optional(),
})

/**
 * Midnight UTC of `now`. The dedup window is a UTC DAY, not a rolling 24h and
 * not the caller's local day: the client never sends a timezone, and a rolling
 * window would make "did I already report this today?" depend on the minute the
 * previous report landed.
 */
function startOfUtcDay(now: Date): Date {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
}

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/report',
        rateLimit: 'mutation',
        origin: true,
        // Resolve-but-never-gate. The extension reports anonymously today and
        // must keep doing so; a session only ADDS the attributed row below. A
        // garbage/expired credential resolves to null and is simply anonymous.
        auth: 'optional',
        body: ReportBodySchema,
    },
    async ({ req, body, session }) => {
        // withRoute threads ONLY `req` to the handler — it deliberately does
        // not forward Next's dynamic route `params` (a path param is
        // route-specific data, not a cross-cutting concern, so the shared
        // 16-route pipeline stays untouched). So parse the id out of the URL
        // path: `/api/coupons/<id>/report` → the second-to-last segment,
        // validated with the same /^\d{1,18}$/ integer shape
        // coupons/increment/route.ts uses (400 on a bad/missing id).
        const segments = new URL(req.url).pathname.split('/')
        const id = segments[segments.length - 2] ?? ''
        if (!/^\d{1,18}$/.test(id)) {
            return NextResponse.json(
                { error: 'Invalid or missing coupon ID' },
                { status: 400 },
            )
        }

        const userId = session?.user?.id ?? null

        // At most one report per outcome per reporter per coupon per 24h
        // (couponReportDedupe.ts): reports are anonymous, a failure sinks then
        // collapses a code, and a success shows it Verified, lists it in "Codes
        // that just worked" and clears its failing state, so one reporter must
        // not be able to move either alone by repeating it. The reporter is the
        // signed-in USER when there is a session (two users behind one IP each
        // keep their own report and attribution row) and the client IP only for
        // anonymous callers. 'worked' and 'failed' have separate slots. A
        // duplicate is a 2xx no-op, never an error: the extension and the web
        // card must not show a failure for a harmless repeat.
        // An ESTABLISHED account weighs as an account toward a failure quorum, a
        // young one as an anonymous network (accountReputation.ts).
        const reporter = reporterFor(
            userId,
            req,
            isEstablishedAccount(session?.user?.createdAt),
        )
        if (!admitReport(body.outcome, reporter, id)) {
            return NextResponse.json({ ok: true, deduped: true })
        }

        // The per-COUPON speed limit (couponReportVelocity.ts): however many
        // distinct reporters there are, only a fixed number of reports of one
        // kind per coupon per hour are counted (established accounts and
        // low-trust reporters have separate buckets). Over it the report
        // is accepted and dropped, answering exactly what a deduped repeat does,
        // so the cap is not observable from outside. The reporter's dedupe slot
        // goes back: nothing landed, so a later report of theirs may still count.
        const tier = velocityTierOf(reporter)
        if (!admitCouponReportVelocity(body.outcome, id, tier)) {
            releaseReport(body.outcome, reporter, id)
            return NextResponse.json({ ok: true, deduped: true })
        }

        // Both slots are taken BEFORE the write so a tracked duplicate stays a
        // database-free no-op; whatever does not land gives them back.
        const giveSlotsBack = () => {
            releaseReport(body.outcome, reporter, id)
            releaseCouponReportVelocity(body.outcome, id, tier)
        }

        // An unknown id writes no signal and gives its slots back, so a forger
        // probing random ids cannot fill the tables with slots no report ever
        // used.
        const unknownCoupon = () => {
            giveSlotsBack()
            return NextResponse.json(
                { error: 'Unknown coupon' },
                { status: 404 },
            )
        }

        try {
            // The aggregate signal write — identical for every caller, so the
            // signed-in path can never end up writing a DIFFERENT signal than the
            // anonymous one. Resolves false when the id is not a catalog row
            // (nothing written).
            const writeSignal = (client: CouponFailureWriter | PrismaClient) =>
                body.outcome === 'worked'
                    ? recordWorked(id, reporter, client)
                    : recordFailed(
                          id,
                          body.storeReason ?? null,
                          reporter,
                          client,
                      )

            if (!userId) {
                // Anonymous: no transaction opened HERE (both writers wrap
                // their own quorum bookkeeping in one). Nothing is written to
                // coupon_reports for an anonymous report — DELIBERATE, not an
                // oversight: coupon_reports is ATTRIBUTION, and every row in it
                // names a user. Anonymous volume is already fully counted by the
                // aggregate, so a user_id NULL row would carry no information the
                // aggregate lacks while doubling the storage and the write cost on
                // the extension's highest-volume path. (The column is nullable
                // because the schema was written before this call; a reader may
                // assume user_id IS NOT NULL for every row this route creates.)
                if (!(await writeSignal(prisma))) return unknownCoupon()
                // Retention of reporter rows, AFTER the write committed. Not
                // awaited: the response never waits for retention, and the sweep
                // never rejects (a failure is captured to Sentry and retried).
                void sweepExpiredReporters()
                return NextResponse.json({ ok: true })
            }

            // Signed in: the signal and the attribution are ONE atomic unit, so a
            // failure can never leave a counted report with no attribution (or the
            // reverse) for a client that will retry.
            const recorded = await prisma.$transaction(async tx => {
                // Written on every report that got past the per-reporter dedupe
                // above, exactly as for an anonymous report. The per-day dedup
                // below applies to the ATTRIBUTION ONLY, and survives a restart
                // that empties the in-memory window.
                if (!(await writeSignal(tx))) return false

                // coupon_reports.coupon_id carries a real FK to `coupons`; the
                // signal write above just proved the row exists, so the insert
                // below cannot raise a foreign-key violation.

                // One attributed report per (user, coupon, UTC day). Postgres
                // cannot express a UNIQUE on date_trunc('day', created_at), so this
                // is app-side by necessity; it rides the
                // (coupon_id, user_id, created_at) index the table ships with. A
                // same-day repeat is IDEMPOTENT — no second row, no error, still
                // 200: a user re-reporting is not a client mistake to be surfaced.
                const alreadyReportedToday = await tx.couponReport.findFirst({
                    where: {
                        couponId: id,
                        userId,
                        createdAt: { gte: startOfUtcDay(new Date()) },
                    },
                    select: { id: true },
                })
                if (alreadyReportedToday) return true

                await tx.couponReport.create({
                    data: { couponId: id, userId, outcome: body.outcome },
                })
                return true
            })
            if (!recorded) return unknownCoupon()
            void sweepExpiredReporters()

            return NextResponse.json({ ok: true })
        } catch (error) {
            // The report never landed: free its slots so a retry is not deduped.
            // withRoute still routes the rethrown error to Sentry.
            giveSlotsBack()
            throw error
        }
    },
)
