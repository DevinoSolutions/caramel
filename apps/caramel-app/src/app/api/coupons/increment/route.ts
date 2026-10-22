import { withRoute } from '@/lib/api/withRoute'
import {
    admitReport,
    releaseReport,
    reporterFor,
} from '@/lib/couponReportDedupe'
import { recordUsage } from '@/lib/couponSignals'
import { isExtensionOrigin } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Lenient — `id` is coerced/validated by hand below exactly as before
// (PRESERVED per PLAN-F-007.md §Breaking, not tightened to 422): the
// schema only needs to accept whatever shape a caller sends without ever
// rejecting it itself, deferring to the same `!= null ? String(id) : ''`
// + regex check the route always did.
const IncrementBodySchema = z.object({
    id: z.unknown().optional(),
})

// Usage counter for a coupon. POST (not GET) so it can't be triggered by
// browser/CDN prefetch — a mutation must never ride a cacheable GET.
// id accepted via ?id= (back-compat) or JSON body.
//
// W4-D2 (RULING C′): usage telemetry is now the app-owned coupon_signals table
// via recordUsage(), NOT an `UPDATE coupons SET times_used…` on the external
// catalog — that write would bump the catalog row's updated_at and freeze it
// under the ingest only-if-newer rule. coupon_signals has no FK to coupons, so
// the id is checked against the catalog IN the write (couponsRepo.writeUsageSignal:
// one INSERT ... SELECT ... WHERE EXISTS statement, so a known id costs one
// statement, not a lookup plus a write): an id that is not a catalog row is a
// 404 and writes nothing (the extension fire-and-forgets this call and reads
// nothing from the response, so the 404 costs it nothing; the HTTP contract
// stays POST / JSON, same rate limit).
// DB errors are NOT swallowed:
// a throw from recordUsage propagates to withRoute's try/catch → handleRouteError
// → Sentry (same as coupons/[id]/report).
//
// Only the extension sends this (background.js, after an apply), so the same
// origin rule as a checkout submission on coupons/submit: withRoute's
// `origin: true` refuses other cross-origin pages, and the handler then refuses
// any PRESENT Origin that is not a browser-extension origin (the Caramel site
// included) with 403. A MISSING Origin is let through, because a background
// fetch under host_permissions may omit it. Chrome and Firefox send one (a
// Firefox 153 request passed the strict extension gate on
// extension/coupon-box-pick in production); Safari is not proven to, and the
// extension's call is fire-and-forget, so a refusal there would silently drop
// real uses. Origin is a browser rule, not authentication:
// any HTTP client can send or drop it, so the per-reporter dedupe below is what
// actually bounds the counter.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/increment',
        rateLimit: 'mutation',
        origin: true,
        // Resolve-but-never-gate, as on coupons/[id]/report: a session only
        // picks the reporter the dedupe keys on.
        auth: 'optional',
        body: IncrementBodySchema,
    },
    async ({ req, body, session }) => {
        if (req.headers.get('origin') !== null && !isExtensionOrigin(req)) {
            // Same body withRoute answers a refused cross-origin page with.
            return NextResponse.json(
                { error: 'Forbidden origin' },
                { status: 403 },
            )
        }

        const url = new URL(req.url)
        let idRaw = url.searchParams.get('id') || ''
        if (!idRaw) {
            idRaw = body?.id != null ? String(body.id) : ''
        }
        if (!/^\d{1,18}$/.test(idRaw)) {
            return NextResponse.json(
                { error: 'Invalid or missing coupon ID' },
                { status: 400 },
            )
        }

        // At most one use per reporter per coupon per 24h (couponReportDedupe.ts),
        // the same reporter the report route keys on. A repeat is a 2xx no-op.
        const reporter = reporterFor(session?.user?.id ?? null, req)
        if (!admitReport('used', reporter, idRaw)) {
            return NextResponse.json({ ok: true, deduped: true })
        }

        // idRaw is the validated numeric string — coupon ids are strings
        // app-side (Coupon.id: string, CouponSignal.couponId: string).
        try {
            // An unknown id counts nothing and gives its dedupe slot back. The
            // slot is taken BEFORE the write so a tracked duplicate stays a
            // database-free no-op.
            if (!(await recordUsage(idRaw))) {
                releaseReport('used', reporter, idRaw)
                return NextResponse.json(
                    { error: 'Unknown coupon' },
                    { status: 404 },
                )
            }
        } catch (error) {
            // The use never landed: free its slot so a retry is counted.
            releaseReport('used', reporter, idRaw)
            throw error
        }
        return NextResponse.json({ ok: true })
    },
)
