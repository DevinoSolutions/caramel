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
// The same table also guards GET /api/coupons for the extension, which is the
// only path an ALREADY-INSTALLED build has to a gated store's codes: builds
// 1.4.13/1.4.14 carry a generic promo-box finder that needs no store config, so
// they offer Caramel on any cart and fetch codes by domain. That endpoint
// cannot ask those builds anything, but it can tell an extension from the
// website (the extension's cross-origin fetch carries a chrome-/moz-/
// safari-web-extension Origin; the website's same-origin one carries none) and
// it can require a build that supports the capability to say so with
// `?caps=<capability>` (CAPABILITY_PROOF_PARAM, sent by coupon-fetch.js from the
// page marker). No proof from an extension means no codes. The website and
// plain API consumers still get the full list.
//
// TODO(2026-10-16): the extension-Origin half of that check is a STOPGAP for
// builds before 1.4.15, which cannot be updated and cannot send `caps`
// (1.4.13/1.4.14 are the ones with the finder). Once those are a negligible
// share of active installs, drop the Origin test and gate on the missing proof
// alone, or drop the gate for a store once its helper ships everywhere.
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

/** Query param an extension build uses to prove the capabilities its page holds. */
export const CAPABILITY_PROOF_PARAM = 'caps'

/**
 * The capabilities a request proves, from `?caps=a,b`. Only names this server
 * knows count; anything else (unknown names, junk) is ignored, so a proof can
 * only ever be a deliberate, recognised claim. A claim is the caller's own, not
 * a credential: the gate stops builds that cannot know about the capability,
 * it does not authenticate the ones that can.
 */
export function parseCapabilityProof(
    raw: string | null,
): ReadonlySet<ExtensionCapability> {
    const proven = new Set<ExtensionCapability>()
    for (const part of (raw ?? '').slice(0, 200).split(',')) {
        const name = EXTENSION_CAPABILITIES.find(c => c === part.trim())
        if (name) proven.add(name)
    }
    return proven
}
