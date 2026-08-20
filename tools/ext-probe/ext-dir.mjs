// Where a build actually lands, and which one the probe loads when nobody says.
//
// Browser-free on purpose (like verdict.mjs): which directory holds a loadable
// extension is a fact about the checkout, not about a run, so it can be pinned
// without launching Chromium.
//
// This module is the ONE owner of WXT's output layout for the probe. The probe
// used to default at `apps/caramel-extension` — the pre-WXT layout, which has
// held no manifest since the migration — while knowing perfectly well where a
// build lands: it carried those paths already, but only to make the refusal
// message name a real directory instead of shrugging. So it refused to default
// to the very build it was naming, and every caller that did not set EXT_DIR
// got exit 71 and no verdict at all. Measured 2026-08-19: ten discovery runs in
// one six-hour window took no extension QA whatsoever, and the configs that
// went unmeasured were the best of the batch.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WXT's chrome build outputs, best first.
 *
 * Production before dev, always. The probe exists to measure what a real
 * shopper gets: the dev build points at dev backends and carries a different
 * env stamp (`verbose:!0`, the tell the served-from-api suite reads), so
 * loading it would answer a question ext-QA is not asking. It stays a
 * candidate only because a checkout that has `pnpm build:dev`'d and nothing
 * else still measures the extension rather than an empty browser.
 *
 * Chrome only: the probe launches Playwright's Chromium, so `.output/firefox-*`
 * and `.output/safari-*` are deliberately absent — Chromium cannot load them,
 * and listing them would turn a refusal into a launch failure.
 */
export function extBuildOutputs(repoRoot) {
    const output = join(repoRoot, 'apps', 'caramel-extension', '.output')
    return [join(output, 'chrome-mv3'), join(output, 'chrome-mv3-dev')]
}

/**
 * The pre-WXT layout. Last resort as a default, and the path the refusal names
 * when the checkout holds nothing loadable at all — an operator recognises it,
 * and "no manifest.json in apps/caramel-extension" is the message that made
 * this whole class of failure legible in the first place.
 */
export function legacyExtDir(repoRoot) {
    return join(repoRoot, 'apps', 'caramel-extension')
}

/**
 * Why Chromium could not load `dir` as an unpacked extension, or null when it
 * can. Kept here so the default RESOLUTION and the launch-time REFUSAL apply
 * one predicate: a default chosen by a laxer rule than the gate that follows
 * it would hand the gate a directory it is about to reject.
 */
export function extensionLoadProblem(dir) {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return `no manifest.json in ${dir}`
    // A manifest Chromium cannot parse loads exactly as well as no manifest at
    // all, and produces the same empty browser.
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (!manifest.version)
            return `${manifestPath} carries no version — Chromium refuses a manifest without one`
    } catch (e) {
        return `${manifestPath} is not parseable JSON: ${e.message}`
    }
    return null
}

/**
 * The directory the probe loads when no EXT_DIR / --ext was given.
 *
 * Prefers a build it can actually load, in the order above. When none is
 * loadable it still returns a path — refusing is the caller's job
 * (`assertLoadableExtension`), and this must never silently succeed. It picks
 * the most informative one: a candidate that HAS a manifest explains why that
 * build is unusable (unparseable, versionless), which beats reporting the
 * absence of a manifest somewhere the operator never built.
 */
export function resolveDefaultExtDir(repoRoot) {
    const candidates = [...extBuildOutputs(repoRoot), legacyExtDir(repoRoot)]
    const loadable = candidates.find(dir => extensionLoadProblem(dir) === null)
    if (loadable) return loadable
    const present = candidates.find(dir =>
        existsSync(join(dir, 'manifest.json')),
    )
    return present || legacyExtDir(repoRoot)
}
