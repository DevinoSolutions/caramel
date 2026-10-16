// owns: page-side capabilities a store's apply config can depend on
// (CARAMEL_CAPABILITY_MARKERS, caramelCapabilityHeld).
//
// WHY: some stores can only be driven safely when a page-world helper is
// running (porkbun.com: porkbun-alert-shim.js, so a refused code does not open
// a blocking alert()). GET /api/coupons withholds such a store's codes from an
// extension that does not say the helper is running (`?caps=`, sent by
// coupon-fetch.js), so a build that never heard of the helper -- every build
// before this file -- gets no codes there and has nothing to try. A build that
// does know must not guess: it asks the PAGE whether the helper is running.
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

// Stores this build knows need a capability. coupon-fetch.js uses it to wait
// for the helper's marker before asking for codes on such a store, because the
// helper may stamp it at the page's load event, after the first fetch would
// have gone out. apps/caramel-app/tests/unit/extension-capability-gates.test.ts
// pins this to the server's EXTENSION_CAPABILITY_GATES.
export const CARAMEL_HOST_CAPABILITY_REQUIREMENTS = Object.freeze({
    'porkbun.com': 'alertShim',
})

export function caramelCapabilityHeld(name, doc = document) {
    const attr = CARAMEL_CAPABILITY_MARKERS[name]
    if (!attr) return false
    return doc.documentElement?.getAttribute(attr) === '1'
}
