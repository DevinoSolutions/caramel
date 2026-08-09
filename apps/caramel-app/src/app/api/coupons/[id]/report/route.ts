import { withRoute } from '@/lib/api/withRoute'
import {
    recordFailed,
    recordWorked,
    type CouponSignalWriter,
} from '@/lib/couponSignals'
import prisma from '@/lib/prisma'
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

        // The aggregate signal write — identical for every caller, so the
        // signed-in path can never end up writing a DIFFERENT signal than the
        // anonymous one.
        const writeSignal = (client: CouponSignalWriter) =>
            body.outcome === 'worked'
                ? recordWorked(id, client)
                : recordFailed(id, body.storeReason ?? null, client)

        if (!userId) {
            // Anonymous — unchanged from before attribution existed: ONE
            // statement, no transaction, no catalog lookup. This is the
            // extension's high-volume path and a BEGIN/COMMIT round-trip around
            // a single upsert would buy nothing. Nothing is written to
            // coupon_reports for an anonymous report — DELIBERATE, not an
            // oversight: coupon_reports is ATTRIBUTION, and every row in it
            // names a user. Anonymous volume is already fully counted by the
            // aggregate, so a user_id NULL row would carry no information the
            // aggregate lacks while doubling the storage and the write cost on
            // the extension's highest-volume path. (The column is nullable
            // because the schema was written before this call; a reader may
            // assume user_id IS NOT NULL for every row this route creates.)
            await writeSignal(prisma)
            return NextResponse.json({ ok: true })
        }

        // Signed in: the signal and the attribution are ONE atomic unit, so a
        // failure can never leave a counted report with no attribution (or the
        // reverse) for a client that will retry.
        await prisma.$transaction(async tx => {
            // Written on EVERY report — first or fifth of the day. Dedup below
            // applies to the ATTRIBUTION ONLY: repeat anonymous reports have
            // always each bumped the aggregate, so suppressing a signed-in
            // user's second report would mean signing in silently weakens the
            // signal the whole catalog is ranked by.
            await writeSignal(tx)

            // coupon_reports.coupon_id carries a real FK to `coupons`
            // (coupon_signals deliberately carries none, so an aggregate can
            // outlive a tombstoned coupon). An id that isn't in the catalog
            // therefore CANNOT be attributed — check first rather than letting
            // the insert raise a foreign-key violation, which would 500 a
            // request that used to return 200. The signal above still lands,
            // exactly as it does for an unknown id today.
            const coupon = await tx.coupon.findUnique({
                where: { id },
                select: { id: true },
            })
            if (!coupon) return

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
            if (alreadyReportedToday) return

            await tx.couponReport.create({
                data: { couponId: id, userId, outcome: body.outcome },
            })
        })

        // withRoute's try/catch routes any thrown error to Sentry (the
        // pipeline default) — no local catch needed.
        return NextResponse.json({ ok: true })
    },
)
