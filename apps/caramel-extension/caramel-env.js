// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: scripts/build-dist.mjs (renderEnvStamp)
// Regenerate the committed package-root copy: node scripts/build-dist.mjs --write-source-stamp
//
// The build-time environment stamp: what this build talks to, decided by HOW
// IT WAS BUILT rather than by a manifest field one store happens to inject.
// See the "environment" block in scripts/build-dist.mjs for why the runtime
// heuristic this replaced was wrong on Firefox and Safari.
//
// The copy at the package root is the DEVELOPMENT stamp and is never copied
// into a package — `pnpm build` writes a fresh PRODUCTION one into dist/.
globalThis.CARAMEL_ENV = Object.freeze({
    name: 'development',
    isProduction: false,
    baseUrl: 'https://dev.grabcaramel.com',
    trustedOrigins: Object.freeze([
        'https://dev.grabcaramel.com',
        'http://localhost:58000',
    ]),
    verbose: true,
})

// Flat alias for the service worker, which sets no globals of its own before
// this loads; scripts/test-extension.mjs reads it out of the live worker to
// prove which deployment the loaded build resolved to.
globalThis.CARAMEL_BASE_URL = globalThis.CARAMEL_ENV.baseUrl
