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
 *     imported from scripts/environments.mjs — one source of truth, no drift.
 *   - One config generates BOTH browser manifests (`-b firefox`); the
 *     `identity` permission and extension-pages CSP are Chrome-only, exactly
 *     like the committed manifest.json / manifest-firefox.json twins.
 */
import { defineConfig } from 'wxt'

import { ENVIRONMENTS, stampFor } from './scripts/environments.mjs'

type EnvironmentName = keyof typeof ENVIRONMENTS

const ICONS = {
    16: '/icons/16.png',
    19: '/icons/19.png',
    32: '/icons/32.png',
    38: '/icons/38.png',
    192: '/icons/192.png',
    512: '/icons/512.png',
}

function resolveEnvironment(mode: string): EnvironmentName {
    // Vite modes map onto the environment table 1:1. Anything else fails the
    // build loudly — a typo must never fall back to either stamp.
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
        // Explicit, root-absolute icon paths — byte-identical to the shipped
        // 1.3.1 manifests. WXT's auto-discovery from public/icons/N.png emits
        // the same files without the leading slash; explicit wins so the
        // parity goldens need no allowlist row for a cosmetic slash.
        icons: ICONS,
        action: {
            default_popup: 'popup.html',
            default_icon: ICONS,
        },
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
                // popup.html is WXT's name for the popup page (was
                // index.html); it stays web-accessible because background.js
                // openPopup opens it as a TAB with ?isPopup=true&callerId=.
                resources: ['popup.html', 'assets/*'],
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
    vite: ({ mode }) => ({
        define: {
            // The build-time environment stamp. caramel-env.js re-exports it
            // as CARAMEL_ENV; the module graph guarantees it is initialized
            // before any reader runs (the successor to caramel-env.js loading
            // first in manifest order).
            __CARAMEL_ENV__: JSON.stringify(stampFor(resolveEnvironment(mode))),
        },
    }),
})
