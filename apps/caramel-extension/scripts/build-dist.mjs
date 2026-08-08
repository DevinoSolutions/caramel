/**
 * Builds `dist/` — the directory that becomes extension.zip and, on the Safari
 * leg, the input to `safari-web-extension-converter`.
 *
 * This used to be `rsync -a --exclude=…` over the whole package, which is a
 * blacklist: everything not named ships. The store package therefore carried
 * package.json, eslint.config.cjs, knip.json, .size-limit.json, .gitignore,
 * README.md, this scripts/ directory (including the iOS simulator shell
 * scripts), the Firefox manifest, and ~400 KB of unreferenced brand source art
 * under assets/Caramel Logos/. None of it is runnable code; all of it was
 * downloaded by every user and read by every store reviewer. rsync also does
 * not exist on Windows, so `pnpm build` only ever worked in CI.
 *
 * So: an ALLOWLIST, and a test (tests/package-contents.test.mjs) that fails the
 * build if anything the manifests or index.html actually reference is missing
 * from it. Adding a file to the extension without adding it here is a red test,
 * not a broken release.
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Everything the packaged extension needs, and nothing else. Paths are
 *  relative to the package root; a directory ships whole. */
export const SHIPPED = [
    'manifest.json',
    'index.html',
    // content scripts, in manifest order, then the popup + service worker
    'coupon-constants.generated.js',
    'cart-signals.js',
    'caramel-base.js',
    'dom-utils.js',
    'store-detect.js',
    'coupon-apply.js',
    'coupon-fetch.js',
    'coupon-runner.js',
    'UI-helpers.js',
    'inject.js',
    'popup.js',
    'background.js',
    'caramel-content.css',
    // icons named by the manifest (icons/original.png is the CI-only source
    // for Safari icon generation and is read from the checkout, not from dist)
    'icons/16.png',
    'icons/19.png',
    'icons/32.png',
    'icons/38.png',
    'icons/192.png',
    'icons/512.png',
    // assets referenced by the popup and the shadow-root UI
    'assets/tokens.css',
    'assets/styles.css',
    'assets/content-ui.css',
    'assets/logo-full.svg',
    'assets/logo-light.png',
    'assets/logo.png',
    'assets/default-profile.png',
]

/** Files that must NEVER reach the package, asserted by the test. Listed by
 *  name rather than inferred so the intent survives a refactor. */
export const NEVER_SHIP = [
    'package.json',
    'eslint.config.cjs',
    'knip.json',
    '.size-limit.json',
    '.gitignore',
    'README.md',
    'vitest.config.mjs',
    'manifest-firefox.json',
    'tests',
    'scripts',
    '.turbo',
    'node_modules',
]

// pathToFileURL, not string-building: a Windows argv[1] is `C:\…`, which only
// becomes a matching URL through proper encoding (`file:///C:/…`).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dist = join(ROOT, 'dist')
    await rm(dist, { recursive: true, force: true })
    await mkdir(dist, { recursive: true })
    for (const entry of SHIPPED) {
        const dest = join(dist, entry)
        await mkdir(dirname(dest), { recursive: true })
        await cp(join(ROOT, entry), dest, { recursive: true })
    }
    console.log(`built dist/ — ${SHIPPED.length} entries`)
}
