/**
 * WXT migration parity harness (P0 deliverable, 2026-08-12; old-build checks
 * retired with scripts/build-dist.mjs in P1).
 *
 * The migration's standing regression gate: proves the WXT build (`.output/`)
 * stays convergent with the shipped 1.3.1 extension and cannot ship the two
 * incident classes this repo already paid for — tooling files in the store
 * package, and a store build stamped dev.
 *
 * Three assertion families, per browser:
 *
 *   1. SEMANTIC MANIFEST DIFF — the frozen 1.3.1 golden manifests (scripts/
 *      parity-golden-*.json, snapshotted when the classic manifests retired)
 *      are the golden spec; the WXT-generated manifests
 *      are diffed against them path by path. Every difference must be listed
 *      in scripts/parity-expected-diffs.json with a reason and the phase that
 *      retires it. An UNLISTED diff fails; a listed diff that no longer occurs
 *      ALSO fails (stale entry — the allowlist only shrinks, so "parity" can
 *      never quietly mean "whatever it currently emits").
 *
 *   2. FILE INVENTORY — no NEVER_SHIP name may exist in any .output build;
 *      every file a generated manifest references must exist in its build.
 *
 *   3. ENV STAMP — production builds must carry the production baseUrl and
 *      ZERO dev origins in any shipped .js; a --mode development WXT build
 *      must carry the dev stamp. This is the Firefox/Safari shipped-dev-build
 *      incident, pinned against the new build system.
 *
 * Runs standalone (like test-guards.mjs): `pnpm test:parity`. Builds
 * everything it checks into gitignored directories.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENVIRONMENTS } from './environments.mjs'

/** Files that must NEVER reach a packaged build, asserted by name rather than
 *  inferred so the intent survives a refactor. Inherited verbatim from the
 *  retired scripts/build-dist.mjs (whose allowlist copy-build this harness
 *  used to cross-check); WXT packages only entrypoint output + public/, but
 *  the incident this list pins — tooling files in the store zip — predates
 *  that guarantee, so the list stays as the independent check. */
const NEVER_SHIP = [
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.output')

const EXPECTED = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'parity-expected-diffs.json'), 'utf8'),
)

const failures = []
let checks = 0
const check = (ok, label) => {
    checks += 1
    if (ok) console.log(`  PASS  ${label}`)
    else {
        failures.push(label)
        console.error(`  FAIL  ${label}`)
    }
}

/* ------------------------------------------------------------------ builds */

// The three artifacts under test. wxt is invoked through its own bin so the
// harness runs identically on a dev machine and in CI (no npx resolution).
const WXT_BIN = join(ROOT, 'node_modules', 'wxt', 'bin', 'wxt.mjs')
const wxt = args =>
    execFileSync(process.execPath, [WXT_BIN, ...args], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
    })

console.log('building: WXT chrome/firefox/dev …')
wxt(['build'])
wxt(['build', '-b', 'firefox', '--mv3'])
wxt(['build', '--mode', 'development'])

const BUILDS = {
    chrome: {
        golden: JSON.parse(
            readFileSync(
                join(ROOT, 'scripts/parity-golden-chrome.json'),
                'utf8',
            ),
        ),
        outDir: join(OUT, 'chrome-mv3'),
    },
    firefox: {
        golden: JSON.parse(
            readFileSync(
                join(ROOT, 'scripts/parity-golden-firefox.json'),
                'utf8',
            ),
        ),
        outDir: join(OUT, 'firefox-mv3'),
    },
}
const DEV_OUT = join(OUT, 'chrome-mv3-dev')

/* ------------------------------------------------- 1. semantic manifest diff */

/** Keys whose array ORDER is meaningless — compared as sets. Content-script
 *  js order is load-bearing and is deliberately NOT here. */
const UNORDERED = new Set(['permissions', 'host_permissions', 'matches'])

const sortIf = (key, value) =>
    Array.isArray(value) && UNORDERED.has(key) ? value.toSorted() : value

/** Flat list of {path, golden, actual} differences between two manifests.
 *  Arrays diff as one unit at their own path — a reshaped content-script list
 *  is ONE diff to explain, not eleven. */
function diffManifests(golden, actual, path = '') {
    const diffs = []
    const keys = new Set([...Object.keys(golden), ...Object.keys(actual)])
    for (const key of keys) {
        const p = `${path}/${key}`
        const g = sortIf(key, golden[key])
        const a = sortIf(key, actual[key])
        if (g === undefined || a === undefined || typeof g !== typeof a) {
            if (JSON.stringify(g) !== JSON.stringify(a))
                diffs.push({ path: p, golden: g, actual: a })
        } else if (Array.isArray(g) || typeof g !== 'object') {
            if (JSON.stringify(g) !== JSON.stringify(a))
                diffs.push({ path: p, golden: g, actual: a })
        } else {
            diffs.push(...diffManifests(g, a, p))
        }
    }
    return diffs
}

for (const [browser, { golden, outDir }] of Object.entries(BUILDS)) {
    const manifest = JSON.parse(
        readFileSync(join(outDir, 'manifest.json'), 'utf8'),
    )
    const diffs = diffManifests(golden, manifest)
    const expected = EXPECTED.diffs.filter(e => e.browser === browser)
    const expectedPaths = new Set(expected.map(e => e.path))
    const actualPaths = new Set(diffs.map(d => d.path))

    for (const d of diffs) {
        check(
            expectedPaths.has(d.path),
            `${browser} manifest ${d.path}: ${JSON.stringify(d.golden)} → ${JSON.stringify(d.actual)}` +
                (expectedPaths.has(d.path) ? '' : ' (UNEXPECTED diff)'),
        )
    }
    for (const e of expected) {
        check(
            actualPaths.has(e.path),
            `${browser} expected-diff ${e.path} still occurs (else remove the stale entry: ${e.reason})`,
        )
    }
}

/* ------------------------------------------------------- 2. file inventory */

const walk = dir =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter(entry => entry.isFile())
        .map(entry =>
            // entry.path is the pre-22 name of parentPath — CI still runs both
            relative(
                dir,
                join(entry.parentPath ?? entry.path, entry.name),
            ).replaceAll('\\', '/'),
        )

// NEVER_SHIP names must not exist in ANY packaged artifact.
for (const [label, dir] of [
    ['wxt chrome', BUILDS.chrome.outDir],
    ['wxt firefox', BUILDS.firefox.outDir],
    ['wxt dev', DEV_OUT],
]) {
    const files = walk(dir)
    const violations = NEVER_SHIP.filter(entry =>
        files.some(f => f === entry || f.startsWith(entry + '/')),
    )
    check(
        violations.length === 0,
        `${label}: no NEVER_SHIP file reaches the package (found: ${violations.join(', ') || 'none'})`,
    )
}

// Every file a generated manifest references must exist in its own build.
// web_accessible_resources entries may be globs; a glob counts as satisfied
// when any packaged file matches it. Missing references listed in the
// expected-diffs "references" allowlist are stub gaps a later phase closes.
for (const [browser, { outDir }] of Object.entries(BUILDS)) {
    const manifest = JSON.parse(
        readFileSync(join(outDir, 'manifest.json'), 'utf8'),
    )
    const files = walk(outDir)
    const refs = []
    for (const cs of manifest.content_scripts ?? []) {
        refs.push(...(cs.js ?? []), ...(cs.css ?? []))
    }
    if (manifest.background?.service_worker)
        refs.push(manifest.background.service_worker)
    refs.push(...(manifest.background?.scripts ?? []))
    if (manifest.action?.default_popup) refs.push(manifest.action.default_popup)
    refs.push(...Object.values(manifest.icons ?? {}))
    refs.push(...Object.values(manifest.action?.default_icon ?? {}))
    for (const war of manifest.web_accessible_resources ?? [])
        refs.push(...(war.resources ?? []))

    const allowedMissing = new Set(
        EXPECTED.missingReferences
            .filter(e => e.browser === browser)
            .map(e => e.path),
    )
    for (const ref of refs) {
        const rel = ref.replace(/^\//, '')
        const found = rel.includes('*')
            ? files.some(f =>
                  new RegExp(
                      '^' +
                          rel
                              .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
                              .replaceAll('*', '.*') +
                          '$',
                  ).test(f),
              )
            : files.includes(rel)
        if (found) {
            check(true, `${browser}: manifest reference ${ref} exists`)
            if (allowedMissing.has(ref))
                check(
                    false,
                    `${browser}: ${ref} exists now — remove its stale missingReferences entry`,
                )
        } else {
            check(
                allowedMissing.has(ref),
                `${browser}: manifest references ${ref} which is missing from the build` +
                    (allowedMissing.has(ref) ? ' (allowlisted stub gap)' : ''),
            )
        }
    }
}

/* ------------------------------------------------------------ 3. env stamp */

const PROD = ENVIRONMENTS.production
const DEV = ENVIRONMENTS.development
const jsFiles = dir => walk(dir).filter(f => f.endsWith('.js'))
const readAll = (dir, list) =>
    list.map(f => readFileSync(join(dir, f), 'utf8')).join('\n')

for (const [label, dir] of [
    ['wxt chrome (production)', BUILDS.chrome.outDir],
    ['wxt firefox (production)', BUILDS.firefox.outDir],
]) {
    const all = readAll(dir, jsFiles(dir))
    check(
        all.includes(PROD.baseUrl),
        `${label}: carries the production baseUrl ${PROD.baseUrl}`,
    )
    for (const origin of DEV.trustedOrigins) {
        check(
            !all.includes(origin),
            `${label}: no dev origin ${origin} in any shipped js`,
        )
    }
    check(!all.includes(DEV.baseUrl), `${label}: no dev baseUrl in shipped js`)

    // Successor to build-environment.test.mjs's "no shipped file branches on
    // update_url" pin (that suite died with the old build): the runtime
    // dev-detection heuristic this whole stamp design replaced must never
    // reappear in a shipped bundle. Comments are stripped first — the history
    // of WHY the heuristic was wrong is worth keeping in source.
    const code = all
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    check(
        !/update_url/.test(code) && !/_isDevInstall/.test(code),
        `${label}: no shipped js branches on update_url/_isDevInstall`,
    )
}
{
    const all = readAll(DEV_OUT, jsFiles(DEV_OUT))
    check(
        all.includes(DEV.baseUrl),
        `wxt --mode development: carries the dev baseUrl ${DEV.baseUrl}`,
    )
    check(
        all.includes('"isProduction":false') ||
            all.includes('isProduction: false') ||
            all.includes('isProduction:!1') ||
            all.includes('isProduction:false'),
        'wxt --mode development: stamp says isProduction false',
    )
}

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures.length}/${checks} parity checks passed.`)
if (failures.length > 0) {
    console.error(`\n${failures.length} parity failure(s).`)
    process.exit(1)
}
