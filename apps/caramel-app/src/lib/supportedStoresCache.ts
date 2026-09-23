// In-process cache for GET /api/extension/supported-stores.
//
// The route's payload is ~15k store_configs rows → a ~1.2 MB JSON document,
// and it is fetched by every extension install. Before this cache each hit
// re-ran the SELECT, re-mapped 15k rows and re-serialized 1.2 MB on the
// single Node main thread — measured 0.8-4 s of blocked event loop per
// request in prod, one of the loads that pushed the container past its
// healthcheck (see api/health/route.ts). Cloudflare only absorbs this when
// its cache rule for the path is in place (RUNBOOK §Edge cache); this cache
// makes origin cheap regardless of what sits in front of it.
//
// What is cached is the FINAL bytes (the serialized body) plus a strong
// ETag, so a warm hit is a Map lookup and a Response construction — no
// mapping, no stringify. TTL matches the route's `s-maxage=300`: the catalog
// changes on ingest pushes (minutes-hours apart), so 5 min of staleness is
// invisible to the extension. In-flight builds are de-duplicated so a
// stampede after expiry runs ONE query, not N.
//
// Single-instance by design (NF-13: no redis) — like the rate limiter, the
// cache is per process. resetSupportedStoresCache() exists for tests and
// for the ingest route, which drops the entry after a store-config upsert
// so a freshly pushed selector is served without waiting out the TTL.
import { listSupportedStoreConfigs } from '@/lib/couponsRepo'
import { createHash } from 'node:crypto'

export const SUPPORTED_STORES_TTL_MS = 5 * 60 * 1000

export interface SupportedStoresPayload {
    /** Serialized `{ supported: [...] }` — the exact response body. */
    body: string
    /** Strong ETag over `body` (quoted, ready for the header). */
    etag: string
    /** Epoch ms at which this entry was built. */
    builtAt: number
}

let cached: SupportedStoresPayload | null = null
let inFlight: Promise<SupportedStoresPayload> | null = null

async function build(): Promise<SupportedStoresPayload> {
    // One row per store, highest-priority active config that has xpath
    // selectors (excludes API-only configs which the extension can't use).
    const rows = await listSupportedStoreConfigs()
    const supported = rows.map(r => ({
        domain: r.store_name,
        couponInput: r.coupon_input_xpath,
        couponSubmit: r.apply_button_xpath,
        priceContainer: r.price_container_xpath ?? undefined,
        showInput: r.show_input_xpath ?? undefined,
        dismissButton: r.dismiss_button_xpath ?? undefined,
        successIndicator: r.success_indicator_xpath ?? undefined,
        errorIndicator: r.error_indicator_xpath ?? undefined,
        couponRemove: r.coupon_remove_xpath ?? undefined,
    }))
    const body = JSON.stringify({ supported })
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
    return { body, etag, builtAt: Date.now() }
}

/**
 * The current payload — served from memory while younger than
 * SUPPORTED_STORES_TTL_MS, rebuilt (once, shared across concurrent callers)
 * otherwise. A rebuild that throws leaves the previous entry untouched, so
 * a transient DB error after a warm cache is never a 500 for the caller.
 */
export async function getSupportedStoresPayload(
    now: number = Date.now(),
): Promise<SupportedStoresPayload> {
    if (cached && now - cached.builtAt < SUPPORTED_STORES_TTL_MS) return cached
    if (!inFlight) {
        inFlight = build()
            .then(fresh => {
                cached = fresh
                return fresh
            })
            .finally(() => {
                inFlight = null
            })
    }
    try {
        return await inFlight
    } catch (err) {
        if (cached) return cached
        throw err
    }
}

/** Drop the cached payload (tests; after an ingest store-config upsert). */
export function resetSupportedStoresCache(): void {
    cached = null
    inFlight = null
}
