/**
 * WXT build config — the migration target for the hand-rolled
 * `scripts/build-dist.mjs` build (WXT migration P0, 2026-08-12).
 *
 * TODO(WXT-P1): this is a SCAFFOLD. The shipping build is still
 * `scripts/build-dist.mjs` → dist/; the entrypoints under `entrypoints/` are
 * stubs. Nothing under `.output/` may be shipped until the P1 ESM port lands
 * and `scripts/parity-harness.mjs` reports zero unexpected diffs.
 *
 * Doctrine carried over from build-dist.mjs (the env block there explains the
 * shipped Firefox/Safari dev-stamp incident this design prevents):
 *   - Which deployment a build talks to is decided AT BUILD TIME, never at
 *     runtime. `wxt build` defaults to production mode; a dev-stamped build
 *     takes an explicit `--mode development`. The environment table itself is
 *     imported from scripts/build-dist.mjs — one source of truth, no drift.
 *   - One config generates BOTH browser manifests (`-b firefox`); the
 *     `identity` permission and extension-pages CSP are Chrome-only, exactly
 *     like the committed manifest.json / manifest-firefox.json twins.
 */
import { defineConfig } from 'wxt'

import { ENVIRONMENTS } from './scripts/build-dist.mjs'

type EnvironmentName = keyof typeof ENVIRONMENTS

function resolveEnvironment(mode: string): EnvironmentName {
    // Vite modes map onto the build-dist environment table 1:1. Anything else
    // fails the build loudly — a typo must never fall back to either stamp.
    if (mode !== 'production' && mode !== 'development') {
        throw new Error(
            `unknown mode "${mode}" — expected one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
        )
    }
    return mode
}

export default defineConfig({
    manifest: ({ browser }) => ({
        name: 'Caramel - Trusted Honey Alternative',
        description:
            'Open‑source coupon extension that auto‑applies deals without selling data or hijacking commissions.',
        browser_specific_settings: {
            gecko: { id: 'caramel@devino.ca' },
        },
        // `identity` (launchWebAuthFlow) exists on Chrome/Edge/Safari builds
        // only; its absence on Firefox is what routes popup sign-in through
        // the website flow. See popup.js popupOAuthSupported().
        permissions:
            browser === 'firefox'
                ? ['tabs', 'activeTab', 'storage', 'alarms']
                : ['tabs', 'activeTab', 'storage', 'identity', 'alarms'],
        host_permissions: ['https://*/*'],
        web_accessible_resources: [
            {
                resources: ['index.html', 'assets/*'],
                matches: ['<all_urls>'],
            },
        ],
        ...(browser === 'firefox'
            ? {}
            : {
                  content_security_policy: {
                      extension_pages:
                          "script-src 'self'; object-src 'self'; frame-ancestors 'none'",
                  },
              }),
    }),
    vite: ({ mode }) => {
        const environment = resolveEnvironment(mode)
        const env = ENVIRONMENTS[environment]
        return {
            define: {
                // The build-time environment stamp, successor to the generated
                // caramel-env.js. Entrypoints assign it to globalThis.CARAMEL_ENV
                // before any other code runs (stamp-first, like manifest order
                // guaranteed for caramel-env.js today).
                __CARAMEL_ENV__: JSON.stringify({
                    name: environment,
                    isProduction: environment === 'production',
                    baseUrl: env.baseUrl,
                    trustedOrigins: env.trustedOrigins,
                    verbose: env.verbose,
                }),
            },
        }
    },
})
