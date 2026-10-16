// Stores whose apply config is only safe for an extension build that can prove
// a page-side helper is running. Consumer: apps/caramel-extension/
// extension-capabilities.js, which holds the matching marker per capability.
//
// WHY THE SERVER SPLITS THE PAYLOAD instead of varying it per request: GET
// /api/extension/supported-stores is one ~1.2 MB body shared by every install,
// cached in-process (supportedStoresCache.ts) and at the Cloudflare edge by
// path (RUNBOOK §Edge cache). A per-request answer (a version header, a query
// param) would either be ignored by that cache or poison it. So a gated store's
// row leaves `supported` — where every extension build since 1.0, which cannot
// know the helper exists, would drive it unprotected — and goes into `gated`,
// tagged with what it `requires`. Builds that predate the bucket never read it.
// Newer builds read it and use a row only while the page proves the capability.
//
// This is a read-side rule on rows the supplier already pushes through POST
// /api/ingest/catalog. It adds no write path and the supplier row is unchanged.
//
// Adding a store here is a deliberate decision: it makes the store invisible to
// every extension build that lacks the capability (they treat it like a store
// with no config). Name the capability in extension-capabilities.js first.
export const EXTENSION_CAPABILITIES = ['alertShim'] as const
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number]

export const EXTENSION_CAPABILITY_GATES: Readonly<
    Record<string, ExtensionCapability>
> = {
    // porkbun.com refuses a coupon with a native alert(), twice per scripted
    // attempt; the helper (porkbun-alert-shim.js) turns that into page text.
    'porkbun.com': 'alertShim',
}

/** The capability a store's apply config requires, or null when ungated. */
export function requiredCapabilityFor(
    storeName: string,
): ExtensionCapability | null {
    const host = storeName.toLowerCase().replace(/^www\./, '')
    return EXTENSION_CAPABILITY_GATES[host] ?? null
}
