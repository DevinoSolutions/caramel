import { env } from '@/lib/env'
import { authorize, timedCheck } from '@/lib/health'
import prisma from '@/lib/prisma'
import { type NextRequest, NextResponse } from 'next/server'

// Catalog freshness window. A catalog whose newest row is older than this is
// reported `stale: true` in the details, but staleness ALONE never fails the
// check (see checkCatalog): the migrated+seeded catalog legitimately ages past
// this in CI/local, and real bridge-sync lag must not 503-flap the gate.
// Tunable per-deploy via CATALOG_MAX_AGE_HOURS (src/lib/env.ts, defaults to
// 48h — the value this constant used to hardcode).
const CATALOG_STALE_THRESHOLD_MS = env.CATALOG_MAX_AGE_HOURS * 60 * 60 * 1000

interface CatalogDetails {
    count: number
    freshestUpdatedAt: string | null
    ageMinutes: number | null
    stale: boolean
}

interface CatalogCheck {
    status: 'ok' | 'error'
    service: 'catalog'
    latencyMs: number
    // Structured freshness on a reachable catalog; the raw error message on an
    // unexpected throw (DB/table unreachable) — matching timedCheck's string
    // `details` convention for the failure case.
    details: CatalogDetails | string
}

// Freshness + non-emptiness probe of the app's OWN published coupon catalog
// (DATABASE_URL — models Coupon/StoreConfig/Source, W4 of the Coupons
// Ownership Inversion). Replaces the pre-W4 `coupons_db` probe of the external
// Python-owned caramel_coupons Postgres, retired in W4-D3 along with the
// porsager couponsSql client + the whole local "degraded mode".
//
// Status is 'ok' iff the aggregate query SUCCEEDS AND the catalog is NON-EMPTY;
// 'error' when the query throws (DB/table unreachable) OR the catalog is empty
// (count === 0). §1's "stale → degraded" signal is the observable `stale` flag
// surfaced in the details — deliberately NOT a hard error: only an unreachable
// or EMPTY catalog is a 503, so the gate never flaps on the seeded-but-unsynced
// state (the static seed ages past the threshold in CI/local) or on legitimate
// sync lag.
async function checkCatalog(): Promise<CatalogCheck> {
    const start = Date.now()
    try {
        const { _count, _max } = await prisma.coupon.aggregate({
            _count: true,
            _max: { updatedAt: true },
        })
        const freshest = _max.updatedAt
        const ageMs = freshest ? Date.now() - freshest.getTime() : null
        const details: CatalogDetails = {
            count: _count,
            freshestUpdatedAt: freshest ? freshest.toISOString() : null,
            ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
            stale: ageMs === null || ageMs > CATALOG_STALE_THRESHOLD_MS,
        }
        return {
            status: _count > 0 ? 'ok' : 'error',
            service: 'catalog',
            latencyMs: Date.now() - start,
            details,
        }
    } catch (err) {
        return {
            status: 'error',
            service: 'catalog',
            latencyMs: Date.now() - start,
            details: err instanceof Error ? err.message : String(err),
        }
    }
}

// F-001 — probes the two data dependencies of this app: the Prisma/auth DB
// (`SELECT 1`) and the app-owned coupon catalog (non-emptiness + freshness,
// see checkCatalog). Body shape {status, checks:{auth_db, catalog}}; the
// external Uptime-Kuma monitor keys on the HTTP status code + top-level
// `status`, both preserved. 200 iff BOTH checks are ok, else 503. Bearer-gated
// (UPKUMA_HEALTH_SECRET) — 401 without it, so no DB is touched unauthenticated.
export async function GET(request: NextRequest) {
    if (!authorize(request))
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [auth_db, catalog] = await Promise.all([
        timedCheck('auth_db', async () => {
            await prisma.$queryRaw`SELECT 1`
        }),
        checkCatalog(),
    ])

    const status =
        auth_db.status === 'ok' && catalog.status === 'ok' ? 'ok' : 'error'

    return NextResponse.json(
        { status, checks: { auth_db, catalog } },
        { status: status === 'ok' ? 200 : 503 },
    )
}
