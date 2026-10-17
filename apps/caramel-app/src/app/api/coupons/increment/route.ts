import { withRoute } from '@/lib/api/withRoute'
import {
    admitReport,
    releaseReport,
    reporterFor,
} from '@/lib/couponReportDedupe'
import { recordUsage } from '@/lib/couponSignals'
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
// under the ingest only-if-newer rule. The signal is keyed by coupon id
// independently of catalog-row existence, so the upsert always succeeds: there
// is no "coupon not found" case, hence no 404 (the extension fire-and-forgets
// this call and reads nothing from the response — the HTTP contract stays POST
// / 200 / JSON, same auth + rate-limit + origin). DB errors are NOT swallowed:
// a throw from recordUsage propagates to withRoute's try/catch → handleRouteError
// → Sentry (same as coupons/[id]/report).
//
// Only the extension sends this (background.js, after an apply), so the origin
// gate is the strict extension one (`'extension'`: the Origin must be present
// and a browser-extension origin), not the site allowlist. That is a browser
// rule: any HTTP client can send such a header, so the per-reporter dedupe
// below is what actually bounds the counter.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/increment',
        rateLimit: 'mutation',
        origin: 'extension',
        // Resolve-but-never-gate, as on coupons/[id]/report: a session only
        // picks the reporter the dedupe keys on.
        auth: 'optional',
        body: IncrementBodySchema,
    },
    async ({ req, body, session }) => {
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
            await recordUsage(idRaw)
        } catch (error) {
            // The use never landed: free its slot so a retry is counted.
            releaseReport('used', reporter, idRaw)
            throw error
        }
        return NextResponse.json({ ok: true })
    },
)
