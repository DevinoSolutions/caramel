// The build-time environment stamp — an ES module since the WXT P1 port
// (2026-08-12). `__CARAMEL_ENV__` is inlined by the build (wxt.config.ts vite
// define; vitest.config.mjs mirrors it for the unit suite) from the ONE table
// in scripts/environments.mjs. Which deployment a build talks to is decided
// by HOW IT WAS BUILT, never at runtime — see environments.mjs for the
// shipped Firefox/Safari dev-stamp incident that rule comes from.
//
// This file used to be GENERATED per build and loaded first in every context
// (manifest order, index.html, worker importScripts). The module graph now
// provides the same guarantee structurally: every reader imports CARAMEL_ENV
// from here, so it cannot evaluate uninitialized.
export const CARAMEL_ENV = Object.freeze({
    ...__CARAMEL_ENV__,
    trustedOrigins: Object.freeze([...__CARAMEL_ENV__.trustedOrigins]),
})

// Flat alias the service worker publishes; scripts/test-extension.mjs reads
// it out of the live worker to prove which deployment a loaded build resolved
// to. Kept as an export for that same probe in the ESM world.
export const CARAMEL_BASE_URL = CARAMEL_ENV.baseUrl

// The pre-ESM realms exposed the stamp as a global; the window/worker
// publication survives the port for the harnesses and any not-yet-ported
// reader that still says `CARAMEL_ENV` bare. Readers migrate to the import.
globalThis.CARAMEL_ENV = CARAMEL_ENV
globalThis.CARAMEL_BASE_URL = CARAMEL_BASE_URL
