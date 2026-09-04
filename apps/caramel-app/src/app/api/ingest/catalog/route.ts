import { withRoute } from '@/lib/api/withRoute'
import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import { IngestCatalogPayloadSchema } from '@/lib/catalog/ingestSchemas'
import { resetSupportedStoresCache } from '@/lib/supportedStoresCache'
import { NextResponse } from 'next/server'

// POST /api/ingest/catalog — the ONE idempotent ingest endpoint of the coupons
// ownership inversion. The external coupons pipeline (a trusted supplier, NOT a
// browser) pushes catalog rows here the moment they change; the app owns the
// catalog and this is its only write door for supplier data.
//
// Auth: a server-only bearer (INGEST_API_KEY) via withRoute's apiKey:'ingest'
// gate (rateLimit.ts's isIngestAuthorized — constant-time, fail-closed on an
// unset key). Distinct from COUPONS_ADMIN_SECRET; never shipped to any client.
//
// Semantics (see src/lib/catalog/applyCatalogRows.ts): a pure DELTA UPSERT —
// each row applied only-if-newer by its own updated_at (idempotent, retry- and
// out-of-order-safe), the whole push transaction-atomic, and a push that would
// tombstone/expire >20% of the visible catalog is refused (409) unless the body
// carries force:true. A 1-row push and a 23k-row push take the identical path.
//
// NO CORS / NO OPTIONS / NO rate-limit: this is server-to-server (no browser
// Origin, no preflight), the bearer gate is the access control, and the trusted
// supplier is deliberately un-throttled so it can push changes as they happen.
// Anything that throws out of applyCatalogRows (bad data mid-batch, DB loss, …)
// propagates to withRoute's try/catch → handleRouteError → Sentry. Never
// swallowed.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'ingest/catalog',
        apiKey: 'ingest',
        body: IngestCatalogPayloadSchema,
    },
    async ({ body }) => {
        const result = await applyCatalogRows(body)
        if (result.gated) {
            // 409 Conflict — the sanity gate refused this push. `result.gate` is
            // present here by the ApplyResult discriminated union (no assertion).
            return NextResponse.json(
                {
                    error: `Ingest refused: this push would expire ${result.gate.wouldTombstone} of ${result.gate.visibleBefore} visible coupons (>${result.gate.thresholdPct}% of the catalog). Resend with force:true if this is intentional.`,
                    gate: result.gate,
                },
                { status: 409 },
            )
        }
        // GET /api/extension/supported-stores serves a 5-min in-process cache
        // of the serialized store_configs projection; drop it the moment a
        // push changes that table so new selectors are live on the next hit.
        if (result.storeConfigs.upserted > 0) resetSupportedStoresCache()
        return NextResponse.json({ ok: true, applied: result }, { status: 200 })
    },
)
