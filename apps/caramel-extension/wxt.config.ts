/**
 * WXT build config — THE build (P1 landed 2026-08-13; the hand-rolled
 * `scripts/build-dist.mjs` → dist/ world is deleted and
 * `scripts/parity-harness.mjs` gates every build against the frozen 1.3.1
 * golden manifests).
 *
 * Doctrine carried over from the retired build-dist.mjs (its env block —
 * see git history — explains the shipped Firefox/Safari dev-stamp incident
 * this design prevents):
 *   - Which deployment a build talks to is decided AT BUILD TIME, never at
 *     runtime. `wxt build` defaults to production mode; a dev-stamped build
 *     takes an explicit `--mode development`. The environment table itself is
 *     imported from scripts/environments.mjs — one source of truth, no drift.
 *   - One config generates BOTH browser manifests (`-b firefox`); the
 *     `identity` permission and extension-pages CSP are Chrome-only, exactly
 *     like the retired manifest.json / manifest-firefox.json twins were.
 */
import { defineConfig } from 'wxt'

import { ENVIRONMENTS, stampFor } from './scripts/environments.mjs'

// React is POPUP-ONLY by doctrine (content scripts stay React-free — the
// module only affects entrypoints that actually import React).

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
    modules: ['@wxt-dev/module-react'],
    zip: {
        // The AMO sources archive (`wxt zip -b firefox` emits it beside the
        // store zip) does NOT honor .gitignore — measured 2026-08-13: it swept
        // in dist/ and dist-parity/, gitignored fossils of the retired
        // hand-rolled build, 58 entries and roughly half the archive. Mozilla
        // reviewers read this archive; hand them the tree a fresh checkout
        // has, not whatever stale build output a local machine accumulated.
        excludeSources: ['dist/**', 'dist-*/**', '.venv/**'],
    },
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
            gecko: {
                id: 'caramel@devino.ca',
                // Mozilla's data-collection consent framework (mandatory for
                // new AMO submissions since 2025-11-03, extending to updates
                // of existing listings during 2026 — declared now so the
                // 1.4.0 submission cannot bounce on it). Firefox-only: Chrome
                // ignores the key and the chrome parity golden stays exact.
                //
                // Evidence-based mapping (full outbound audit 2026-08-13; the
                // ONLY server origin is the build-time baseUrl — no Sentry,
                // no analytics, nothing third-party):
                //   required.browsingActivity — the toolbar badge sends every
                //     visited https domain to /api/coupons on tab switch,
                //     guests included, no off switch.
                //   required.websiteContent — /api/classify-cart sends page
                //     title/meta/product names; coupon outcome reports carry
                //     the store's own rejection text. Both automatic.
                //   optional.authenticationInfo + personallyIdentifyingInfo —
                //     email/password (and OAuth codes on non-Firefox) travel
                //     only when the user signs in; guests never send them.
                //   optional.financialAndPaymentInfo — savings sync uploads
                //     per-win {store, code, amountCents} records, and is
                //     double-gated: sign-in AND an off-by-default toggle.
                // Deliberately ABSENT: technicalAndInteraction (timings and
                // error buffers live in chrome.storage.local with no reader
                // that transmits them — declaring it would disclose
                // collection that doesn't happen), websiteActivity (we click
                // checkout buttons, we never transmit interaction data),
                // searchTerms (the key_words API param is '' at all call
                // sites).
                ...(browser === 'firefox'
                    ? {
                          data_collection_permissions: {
                              required: ['browsingActivity', 'websiteContent'],
                              optional: [
                                  'authenticationInfo',
                                  'personallyIdentifyingInfo',
                                  'financialAndPaymentInfo',
                              ],
                          },
                      }
                    : {}),
            },
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
