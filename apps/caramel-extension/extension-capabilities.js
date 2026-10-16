// owns: page-side capabilities a store's apply config can depend on
// (CARAMEL_CAPABILITY_MARKERS, caramelCapabilityHeld).
//
// WHY: some stores can only be driven safely when a page-world helper is
// running (porkbun.com: porkbun-alert-shim.js, so a refused code does not open
// a blocking alert()). The server publishes such a store's apply config in the
// `gated` bucket of GET /api/extension/supported-stores, tagged with the
// capability it `requires`, and ONLY a build that understands `gated` ever
// reads it — builds without this file never look at the bucket, so they cannot
// auto-apply on that store at all. A build that does look still must not
// guess: it asks the PAGE whether the helper is actually running.
//
// The answer is a marker the helper stamps on <html> from its own world. The
// DOM is the one thing both worlds share, so this measures what ran on this
// page in this browser — not what the manifest asked for. That matters
// because `world: 'MAIN'` is silently inert in a browser that ignores it
// (Chrome < 111, an older Firefox, Safari): the content script then runs in
// the isolated realm, where its alert wrapper changes nothing the page can
// see, and no marker is written.
//
// Fail closed: a capability this build does not know is not held. Names are
// the producer's contract: apps/caramel-app/src/lib/extensionCapabilityGates.ts
// publishes them and tests/unit/extension-capability-gates.test.ts pins the two
// lists to each other.

export const CARAMEL_CAPABILITY_MARKERS = Object.freeze({
    alertShim: 'data-caramel-alert-shim',
})

// Stores this build knows need a capability, whatever the server says. The
// server's `gated` bucket keeps the config away from OLD builds; this table is
// for THIS one, so that (a) a row that reached `supported` anyway (the supplier
// pushed before the server change was live, or a cached payload from before it)
// is still withheld, and (b) the generic paths that need no config at all (the
// platform-cart probe, the promo-box finder) stay off the store too.
// apps/caramel-app/tests/unit/extension-capability-gates.test.ts pins this to
// the server's EXTENSION_CAPABILITY_GATES.
export const CARAMEL_HOST_CAPABILITY_REQUIREMENTS = Object.freeze({
    'porkbun.com': 'alertShim',
})

export function caramelCapabilityHeld(name, doc = document) {
    const attr = CARAMEL_CAPABILITY_MARKERS[name]
    if (!attr) return false
    return doc.documentElement?.getAttribute(attr) === '1'
}
