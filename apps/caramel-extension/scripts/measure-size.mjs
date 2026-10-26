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
 * ── realms are bundled from their entrypoint, as they ship ─────────────────────
 * A realm WXT builds from an entrypoint (the content script, the background
 * worker, the porkbun alert) is weighed as ONE esbuild bundle of that
 * entrypoint: the same import closure the build ships, with top-level names
 * shortened and the import/export lines gone. Until 2026-10-26 these were
 * minified one file at a time, which charged every module boundary for its
 * full-length export names and import statements: splitting a 1,500-line file
 * into two cost bytes the shipped bundle never pays, and a module a realm
 * imports but the hand-kept list missed (code-sharing-consent.js in the
 * content script, tab-handoff.js in the worker) was never weighed (T-5446).
 *
 * Tree-shaking stays ON, as in the real build. The old warning against it was
 * about files with no importer (a classic content script the browser injects
 * is unreachable from anything): an entrypoint is the realm's composition root,
 * every init it calls is reachable, and code it cannot reach is dropped from
 * the shipped bundle too, so not weighing it is the honest count.
 *
 * ── on-demand modules and the popup stay per file ───────────────────────────
 * esbuild's transform API, one file at a time. The on-demand modules ship
 * exactly that way (wxt.config.ts build:publicAssets runs the same transform),
 * and the popup groups weigh our code without the react/react-dom vendor that
 * shares its chunk (see the popup-react note below).
 *
 * ── what this does and does not bound ────────────────────────────────────────
 * The production build is minified as well (checked 2026-10-26: the shipped
 * content.js is 94.48 kB against 91.9 kB measured here, the rest being WXT's
 * own runtime wrapper), so these numbers track the store download closely.
 * They stop at script: the content stylesheet and the icons are not weighed.
 */
import { build, transform } from 'esbuild'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFinderModule } from './finder-bundle.mjs'

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

/* The one place the measured sets live. .size-limit.js points at this
 * script's OUTPUT, so it cannot drift from this list. A group is either
 * `{ entry }`, a realm weighed as the bundle of its WXT entrypoint (a module
 * the realm imports is weighed the day it is imported), or a file list, each
 * file minified on its own. */
export const GROUPS = {
    // Injected on every https page (entrypoints/content.ts): THE per-page
    // budget.
    'content-scripts': { entry: 'entrypoints/content.ts' },
    // popup.js became popup-core.js in P2: the logic module keeps its own
    // budget, and the React views/shell get theirs below. permission-state.js
    // is popup-realm logic too (popup-core imports it; the views call its
    // request helper), so it is weighed here rather than escaping the ratchet
    // by being a new file.
    popup: ['popup-core.js', 'permission-state.js'],
    // The popup's OWN React code (P2): everything TSX/TS under the popup
    // entrypoint plus caramel-ui's sources, which ship in the same chunk.
    // Deliberately NOT the built chunk: react/react-dom are a fixed vendor
    // cost pinned by the lockfile, and weighing them would let 180 kB of
    // vendor noise hide real growth in the code this ratchet exists to bound.
    'popup-react': async () => [
        ...(await tsSourcesUnder('entrypoints/popup')),
        ...(await tsSourcesUnder('../../packages/caramel-ui/src')),
    ],
    background: { entry: 'entrypoints/background.ts' },
    // Not injected: the build ships it as assets/coupon-box-outline.js and the
    // finder imports it only when it is about to ask the server for a box
    // (wxt.config.ts). Its own budget, so it can neither hide in nor inflate
    // the per-page one.
    'coupon-box-outline': ['coupon-box-outline.js'],
    // Injected only on porkbun.com/checkout/* (entrypoints/porkbun-alert.content.ts,
    // MAIN world), so it neither hides in nor inflates the per-page budget.
    'porkbun-alert': { entry: 'entrypoints/porkbun-alert.content.ts' },
    // The same, for the coupon-box selector builder: imported only on a store
    // with no config, when the finder has a box to save (wxt.config.ts).
    'coupon-box-selectors': ['coupon-box-selectors.js'],
}

// Match the floor the extension already ships against (MV3 is evergreen
// Chrome/Firefox/Safari). A lower target would transpile modern syntax down
// and inflate the count with polyfilled output no browser we support would
// ever receive.
const TARGET = 'es2022'

/** Minified bytes of one realm: its entrypoint bundled the way it ships. */
async function bundleEntry(entry) {
    // A syntax error or an unresolved import must stop the build rather than
    // silently measure a smaller file: esbuild throws, and nothing catches it.
    const result = await build({
        entryPoints: [join(ROOT, entry)],
        bundle: true,
        format: 'esm',
        minify: true,
        target: TARGET,
        platform: 'browser',
        write: false,
        // The content stylesheet WXT attaches to the manifest is not code;
        // these budgets bound script.
        loader: { '.css': 'empty' },
        logLevel: 'silent',
    })
    return result.outputFiles[0].text
}

/** Minified bytes of a file list, each file on its own. */
async function minifyEach(files) {
    const minified = []
    for (const file of files) {
        const source = await readFile(join(ROOT, file), 'utf8')
        const ext = extname(file)
        const { code } = await transform(source, {
            loader: ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : 'js',
            minify: true,
            target: TARGET,
        })
        minified.push(code)
    }
    return minified.join('\n')
}

/** One group, written as a single file for size-limit. */
async function buildGroup(name, group) {
    const code =
        typeof group === 'function'
            ? await minifyEach(await group())
            : Array.isArray(group)
              ? await minifyEach(group)
              : await bundleEntry(group.entry)
    const out = join(ROOT, CACHE_DIR, `${name}.min.js`)
    await writeFile(out, code)
    return out
}

const cache = join(ROOT, CACHE_DIR)
await rm(cache, { recursive: true, force: true })
await mkdir(cache, { recursive: true })
for (const [name, group] of Object.entries(GROUPS)) {
    await buildGroup(name, group)
}
// The finder loaded on demand is weighed as it ships: one bundled file, built
// by the same function the build uses (scripts/finder-bundle.mjs).
await writeFile(
    join(cache, 'coupon-box-finder.min.js'),
    await buildFinderModule(ROOT),
)
