/* Prepares what `size-limit` weighs: each shipped script, MINIFIED.
 *
 * The budgets used to be measured over raw source, which meant they priced
 * prose. Every explanatory comment this codebase's house style requires was
 * counted as if it were executable weight, and the consequence is written out
 * across .size-limit.js: seven raises in four days, most of them paying for
 * sentences, one of them an afternoon spent shaving comments to fit a budget
 * whose stated purpose is bounding CODE. A gate that makes documenting a fix
 * more expensive than shipping it is pushing in the wrong direction.
 *
 * So the numbers now come from minified output: comments and formatting are
 * gone before anything is weighed, and what remains is roughly the code. Add
 * fifty lines of explanation and the measurement does not move; add fifty
 * lines of logic and it does.
 *
 * ── minify, do NOT bundle ────────────────────────────────────────────────────
 * esbuild's transform API, one file at a time, never `build`. Bundling would
 * tree-shake, and tree-shaking a set of files whose entry points are the
 * BROWSER (a content script is injected, nothing imports it) would drop every
 * top-level function as unreachable and report a fraction of the real size —
 * a gate that reads green because it deleted the code it was supposed to
 * weigh. Per-file transform has no cross-file view and therefore no way to
 * decide anything is unused.
 *
 * ── what this does and does not bound ────────────────────────────────────────
 * Honest caveat: the shipped package is NOT minified. The WXT build ships
 * these modules with comments intact, so a store download really does carry
 * them. This gate deliberately does not measure that, because transfer size
 * is a once-per-install cost while the thing worth bounding is the code that
 * parses and runs on every store page a shopper visits. If the shipped
 * artifact ever needs a byte ceiling too, that is a second budget over
 * .output/ — not a reason to go back to pricing sentences.
 */
import { transform } from 'esbuild'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_DIR = '.size-cache'

/** Every .ts/.tsx under `dir`, repo-relative, sorted — so a new popup view is
 *  weighed the day it is added instead of drifting out of the file list. */
async function tsSourcesUnder(dir) {
    const entries = await readdir(join(ROOT, dir), {
        recursive: true,
        withFileTypes: true,
    })
    return entries
        .filter(e => e.isFile() && /\.(ts|tsx)$/.test(e.name))
        .map(e => relative(ROOT, join(e.parentPath, e.name)))
        .sort()
}

/* The one place the measured file sets live. .size-limit.js points at this
 * script's OUTPUT, so it cannot drift from this list: a file added to a group
 * here is weighed there without touching the budgets file. Content scripts are
 * in load order, matching manifest.json. */
export const GROUPS = {
    'content-scripts': [
        'caramel-env.js',
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
    ],
    // popup.js became popup-core.js in P2: the logic module keeps its own
    // budget, and the React views/shell get theirs below.
    popup: ['popup-core.js'],
    // The popup's OWN React code (P2): everything TSX/TS under the popup
    // entrypoint plus caramel-ui's sources, which ship in the same chunk.
    // Deliberately NOT the built chunk: react/react-dom are a fixed vendor
    // cost pinned by the lockfile, and weighing them would let 180 kB of
    // vendor noise hide real growth in the code this ratchet exists to bound.
    'popup-react': async () => [
        ...(await tsSourcesUnder('entrypoints/popup')),
        ...(await tsSourcesUnder('../../packages/caramel-ui/src')),
    ],
    background: ['background.js'],
}

/** Minified bytes of one group, written as a single file for size-limit. */
async function buildGroup(name, files) {
    const minified = []
    for (const file of files) {
        const source = await readFile(join(ROOT, file), 'utf8')
        const ext = extname(file)
        // A syntax error here must stop the build rather than silently
        // measure a smaller file: esbuild throws, and nothing catches it.
        const { code } = await transform(source, {
            loader: ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : 'js',
            minify: true,
            // Match the floor the extension already ships against (MV3 is
            // evergreen Chrome/Firefox/Safari). A lower target would transpile
            // modern syntax down and inflate the count with polyfilled output
            // no browser we support would ever receive.
            target: 'es2022',
        })
        minified.push(code)
    }
    const out = join(ROOT, CACHE_DIR, `${name}.min.js`)
    await writeFile(out, minified.join('\n'))
    return out
}

const cache = join(ROOT, CACHE_DIR)
await rm(cache, { recursive: true, force: true })
await mkdir(cache, { recursive: true })
for (const [name, files] of Object.entries(GROUPS)) {
    await buildGroup(name, typeof files === 'function' ? await files() : files)
}
