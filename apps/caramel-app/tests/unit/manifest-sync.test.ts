import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// R-04 — manifest single-source drift gate.
//
// manifest.json (Chrome/Edge) and manifest-firefox.json are hand-maintained
// twins. Most of each file is genuinely browser-specific (see "DELIBERATE
// per-browser differences" below) — but a core set of brand/asset/behaviour
// fields MUST stay byte-identical, and the shared content-script list must not
// drift out of sync. A field silently diverging (a renamed icon, a content
// script added to one browser but not the other) ships a broken or off-brand
// build to one store's users with nothing to catch it. This gate reads BOTH
// real manifest files, so it fails again the moment either drifts — it does
// NOT re-check that referenced files exist on disk (repo-integrity.test.ts
// already owns that invariant).
//
// DELIBERATE per-browser differences this gate INTENTIONALLY does NOT equate
// (documented so the next agent doesn't "helpfully" force them together):
//   * version           — Chrome and Firefox stores carry independent version
//                          numbers; release-extension.yml bumps them separately.
//   * permissions        — Chrome additionally holds `identity` (popup OAuth
//                          via launchWebAuthFlow); the rest is shared.
//   * host_permissions    — Chrome requests broad `https://*/*`; Firefox review
//                          policy favours the narrow per-store + relay-origin list.
//   * content_security_policy — Chrome-only key.
//   * background          — `service_worker` (Chrome MV3) vs `scripts` (FF MV3).
//
// NO LONGER DIFFERENT (ba8c48f, 2026-08-04 — "stop the firefox manifest
// injecting a different bundle than chrome"): host_permissions,
// content_scripts.matches, content_scripts.css and the injected js list are
// now identical in both manifests. Firefox had been shipping a narrow
// hand-listed store set while Chrome matched every https origin, so Firefox
// users silently got the extension on almost no stores and never got
// cart-signals.js at all.
//
// That commit left THIS file asserting the opposite — that cart-signals.js is
// Chrome-only — so these two tests failed from the moment the bug was fixed.
// Content-script parity is now owned, closer to the manifests themselves, by
// apps/caramel-extension/tests/manifest-parity.test.mjs (same scripts and
// order, same stylesheets, same matches, same host permissions, cart-signals
// first). Re-asserting it here would be a second copy free to drift again in
// the other direction, which is the exact failure mode this file exists to
// prevent — so the stale duplicates are gone rather than inverted.

const EXTENSION_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension',
)

interface ContentScript {
    js?: string[]
    css?: string[]
    matches?: string[]
    run_at?: string
}
interface Manifest {
    manifest_version?: number
    name?: string
    description?: string
    icons?: Record<string, string>
    browser_specific_settings?: unknown
    web_accessible_resources?: unknown
    action?: unknown
    content_scripts?: ContentScript[]
}

function readManifest(name: string): Manifest {
    return JSON.parse(
        fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8'),
    ) as Manifest
}

const chrome = readManifest('manifest.json')
const firefox = readManifest('manifest-firefox.json')

describe('R-04: extension manifests stay in sync on shared fields', () => {
    // Fields that describe the SAME extension regardless of browser: brand,
    // assets and popup wiring. A drift here is always a mistake.
    it.each([
        ['manifest_version', (m: Manifest) => m.manifest_version],
        ['name', (m: Manifest) => m.name],
        ['description', (m: Manifest) => m.description],
        ['icons', (m: Manifest) => m.icons],
        [
            'browser_specific_settings',
            (m: Manifest) => m.browser_specific_settings,
        ],
        [
            'web_accessible_resources',
            (m: Manifest) => m.web_accessible_resources,
        ],
        ['action', (m: Manifest) => m.action],
    ] as const)('%s is identical across both manifests', (_label, pick) => {
        expect(pick(firefox)).toEqual(pick(chrome))
    })

    it('each manifest declares exactly one content_scripts block', () => {
        expect(chrome.content_scripts).toHaveLength(1)
        expect(firefox.content_scripts).toHaveLength(1)
    })

    it('content-script run_at agrees (both default / undefined, or both equal)', () => {
        expect(firefox.content_scripts?.[0].run_at).toEqual(
            chrome.content_scripts?.[0].run_at,
        )
    })
})
