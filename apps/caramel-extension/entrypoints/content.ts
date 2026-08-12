/**
 * TODO(WXT-P1): SCAFFOLD STUB — not the real content script. The shipping
 * content-script realm is still the 11-file global-scope chain listed in
 * manifest.json. P1 converts that chain to ES modules and composes it HERE in
 * the same load order. Until then this stub exists so `wxt build` produces an
 * output the parity harness (scripts/parity-harness.mjs) can diff.
 */
export default defineContentScript({
    matches: ['https://*/*'],
    main() {
        // Stamp-first doctrine: CARAMEL_ENV is assigned before anything else
        // evaluates, exactly like caramel-env.js loading first in manifest
        // order today. __CARAMEL_ENV__ is inlined at build time from the
        // ENVIRONMENTS table in scripts/build-dist.mjs (see wxt.config.ts).
        globalThis.CARAMEL_ENV = Object.freeze(__CARAMEL_ENV__)
    },
})
