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

import { readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Everything the packaged extension needs, and nothing else. Paths are
 *  relative to the package root; a directory ships whole. */
export const SHIPPED = [
    'manifest.json',
    'index.html',
    // content scripts, in manifest order, then the popup + service worker
    // (caramel-env.js loads before all of them but is GENERATED, not copied —
    // see GENERATED / renderEnvStamp below)
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

/* ============================================================ environment
 *
 * Which deployment a build talks to is decided HERE, at packaging time, and
 * written into the artifact as `caramel-env.js`. It used to be decided at
 * runtime by `_isDevInstall()`, which read `chrome.runtime.getManifest()
 * .update_url` — a field the Chrome Web Store injects into installed
 * extensions. That heuristic is Chrome-only, and it was wrong everywhere else:
 *
 *   - Firefox/AMO listed add-ons must be uploaded WITHOUT an update_url, and
 *     manifest-firefox.json has none.
 *   - The Safari conversion produces a manifest with no update_url either
 *     (checked on the converted output: zero occurrences).
 *
 * So both of those SHIPPED builds looked like unpacked dev installs: they
 * pointed real users' API calls, login tab and store catalog at the dev
 * deployment, trusted a dev origin to postMessage a session token into
 * extension storage, and printed our internals into every store's console.
 *
 * Default is PRODUCTION, and dev takes an explicit `--env=development`. The
 * asymmetry is deliberate: the failure we are fixing is a shipped build
 * quietly talking to dev, whereas a local build talking to prod is a thing a
 * developer chose, on their own machine, with the flag right there in the
 * command they ran.
 */
export const ENV_FILE = 'caramel-env.js'

/** Files the build WRITES into dist rather than copying from the package. */
export const GENERATED = [ENV_FILE]

export const ENVIRONMENTS = {
    production: {
        baseUrl: 'https://grabcaramel.com',
        // Origins trusted to postMessage a login token into extension
        // storage. They must match the deployment this build talks to: a
        // build whose API is dev has no business accepting a PRODUCTION
        // session relayed from a prod tab, and vice versa.
        trustedOrigins: [
            'https://grabcaramel.com',
            'https://www.grabcaramel.com',
        ],
        // Content scripts run on https://*/*, so a console call lands in a
        // STORE's console on a shopper's machine. Never in a shipped build.
        verbose: false,
    },
    development: {
        baseUrl: 'https://dev.grabcaramel.com',
        trustedOrigins: [
            'https://dev.grabcaramel.com',
            'http://localhost:58000',
        ],
        verbose: true,
    },
}

// Not exported: nothing outside should be able to read the default and then
// "helpfully" pass it back in. A caller either names an environment or gets
// the safe one.
const DEFAULT_ENVIRONMENT = 'production'

/**
 * Renders `caramel-env.js` — the first script every context loads (content
 * scripts, the popup page, and the service worker via importScripts), so the
 * stamp is in place before any file that reads it evaluates.
 *
 * Output must be prettier-clean: the package-root copy of this file is
 * committed (it is the DEVELOPMENT stamp, used when the repo directory itself
 * is loaded unpacked) and `pnpm prettier-check` reads it like any other
 * source file. tests/build-environment.test.mjs pins the committed copy
 * against this renderer, so the two cannot drift.
 *
 * @param {keyof typeof ENVIRONMENTS} name
 * @returns {string} JavaScript source
 */
export function renderEnvStamp(name) {
    const env = ENVIRONMENTS[name]
    if (!env) {
        throw new Error(
            `unknown environment "${name}" — expected one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
        )
    }
    // Single quotes because prettier rewrites double ones and this output is
    // checked by `prettier --check`. Safe as a plain wrap: every value here is
    // a literal from ENVIRONMENTS above, none of which contain a quote.
    const q = value => `'${value}'`
    const origins = env.trustedOrigins
        .map(origin => `        ${q(origin)},\n`)
        .join('')
    return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: scripts/build-dist.mjs (renderEnvStamp)
// Regenerate the committed package-root copy: node scripts/build-dist.mjs --write-source-stamp
//
// The build-time environment stamp: what this build talks to, decided by HOW
// IT WAS BUILT rather than by a manifest field one store happens to inject.
// See the "environment" block in scripts/build-dist.mjs for why the runtime
// heuristic this replaced was wrong on Firefox and Safari.
//
// The copy at the package root is the DEVELOPMENT stamp and is never copied
// into a package — \`pnpm build\` writes a fresh PRODUCTION one into dist/.
globalThis.CARAMEL_ENV = Object.freeze({
    name: ${q(name)},
    isProduction: ${name === 'production'},
    baseUrl: ${q(env.baseUrl)},
    trustedOrigins: Object.freeze([
${origins}    ]),
    verbose: ${env.verbose},
})

// Flat alias for the service worker, which sets no globals of its own before
// this loads; scripts/test-extension.mjs reads it out of the live worker to
// prove which deployment the loaded build resolved to.
globalThis.CARAMEL_BASE_URL = globalThis.CARAMEL_ENV.baseUrl
`
}

/**
 * The ordered sources of a hand-built content-script realm, stamp FIRST.
 *
 * A browser gets the stamp from the manifest; a harness that evaluates these
 * files itself (scripts/test-extension.mjs injects them into a blank page to
 * drive the real applyCoupon()) has to supply it, and caramel-base.js reads
 * CARAMEL_ENV in its own top-level initializers — so a realm without it dies
 * with `CARAMEL_ENV is not defined` at load. CI caught exactly that once. It
 * cannot happen again through this function: the stamp is prepended by
 * construction, not by the caller remembering to list it.
 *
 * @param {string[]} files - content-script files, in load order, WITHOUT the
 *   stamp (relative to the package root).
 * @param {{ stamp?: string }} [options] - `stamp` overrides the rendered
 *   default, for a harness pointing the build at its own local app.
 * @returns {string[]} sources to evaluate in order
 */
export function contentScriptRealmSources(files, { stamp } = {}) {
    return [
        stamp ?? renderEnvStamp(DEFAULT_ENVIRONMENT),
        ...files.map(file => readFileSync(join(ROOT, file), 'utf8')),
    ]
}

/**
 * Builds a package directory: the allowlist, copied, plus a freshly written
 * environment stamp.
 *
 * @param {{ outDir: string, environment?: string }} options
 */
export async function buildDist({ outDir, environment = DEFAULT_ENVIRONMENT }) {
    // Render BEFORE deleting anything, so an unknown --env name fails without
    // having destroyed the previous build.
    const stamp = renderEnvStamp(environment)
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    for (const entry of SHIPPED) {
        const dest = join(outDir, entry)
        await mkdir(dirname(dest), { recursive: true })
        await cp(join(ROOT, entry), dest, { recursive: true })
    }
    await writeFile(join(outDir, ENV_FILE), stamp)
    return { environment, entries: SHIPPED.length + GENERATED.length }
}

// pathToFileURL, not string-building: a Windows argv[1] is `C:\…`, which only
// becomes a matching URL through proper encoding (`file:///C:/…`).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2)
    if (args.includes('--write-source-stamp')) {
        // Rewrites the committed package-root stamp. Development, always:
        // that copy exists for `pnpm dev` / an unpacked load of this
        // directory, and a production one there would silently point a
        // developer's browser at real users' data.
        await writeFile(join(ROOT, ENV_FILE), renderEnvStamp('development'))
        console.log(`wrote ${ENV_FILE} — development stamp`)
    } else {
        const flag = args.find(arg => arg.startsWith('--env='))
        const environment = flag ? flag.slice('--env='.length) : undefined
        const built = await buildDist({
            outDir: join(ROOT, 'dist'),
            environment,
        })
        console.log(
            `built dist/ — ${built.entries} entries, ${built.environment} (${ENVIRONMENTS[built.environment].baseUrl})`,
        )
    }
}
