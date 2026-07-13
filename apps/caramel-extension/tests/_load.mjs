// Shared test harness (F-004): loads a plain <script>-global extension
// source file (shared-utils.js, background.js — no import/export) into the
// current jsdom `window` via read-file + `(0,eval)`, the same trick the
// Playwright e2e suite already uses against a real browser page
// (scripts/test-extension.mjs:209-250, chrome stub shape at :238-248).
//
// The chrome stub here is a permissive Proxy rather than that exact
// hand-enumerated shape: shared-utils.js is a 1536-line file with far more
// surface than the applyCoupon() path the e2e suite exercises (it also
// touches chrome.storage.local, chrome.runtime.getManifest, etc. at module
// scope), so anything not explicitly known is a safe callable no-op instead
// of a ReferenceError/TypeError that would abort the whole-file eval.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const EXT_ROOT = path.resolve(__dirname, '..')

function makeChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol') {
                    return undefined
                }
                if (!(prop in obj)) {
                    obj[prop] = wrap(function () {})
                }
                return obj[prop]
            },
            apply() {
                return undefined
            },
        })
        cache.set(target, proxy)
        return proxy
    }
    return wrap(function chromeStubRoot() {})
}

// Populated by installChromeStub() each call; exposed via
// getOnMessageListeners() for tests that need to invoke a source file's
// registered chrome.runtime.onMessage handler directly.
let onMessageListeners = []

/**
 * Installs a fresh permissive chrome/browser stub on globalThis (and
 * window, belt-and-suspenders — vitest's jsdom environment keeps the two
 * in sync, but the source under test only ever checks the bare identifier).
 *
 * runtime.onMessage.addListener/removeListener are the one deliberate
 * exception to "everything is a no-op": they record real listeners so
 * tests can retrieve and invoke them (see getOnMessageListeners()).
 */
export function installChromeStub() {
    const stub = makeChromeStub()
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    stub.runtime.onMessage.removeListener = fn => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = fn => listeners.includes(fn)
    onMessageListeners = listeners

    globalThis.chrome = stub
    globalThis.browser = undefined
    if (typeof window !== 'undefined') {
        window.chrome = stub
        window.browser = undefined
    }
    return stub
}

/** Listeners registered via chrome.runtime.onMessage.addListener since the
 * last installChromeStub() call (loadExtensionSource() calls it once). */
export function getOnMessageListeners() {
    return onMessageListeners
}

/**
 * Reads and evaluates `fileNames`, IN ORDER, via indirect eval (global
 * scope, matching how a <script> tag would run each one) — installing the
 * chrome/browser stub exactly ONCE before the first file, not once per
 * file. This mirrors a real content-script realm (manifest.json /
 * manifest-firefox.json's content_scripts[].js array, or index.html's
 * <script> tags): the browser hands the whole realm ONE `chrome` global
 * that every file in the list shares, so a listener a LATER file registers
 * (e.g. coupon-runner.js's `currentBrowser.runtime.onMessage.addListener`)
 * lands on the SAME stub instance `currentBrowser` was bound to when the
 * FIRST file's bootstrap ran (caramel-base.js). Re-installing the stub per
 * file (the single-file `loadExtensionSource` below does this, correctly,
 * for its one-file-at-a-time case) would silently orphan that registration
 * on a stub nobody reads from anymore — this function exists so a multi-
 * file load (F-008's split) doesn't reintroduce that bug.
 *
 * Captures the requested bindings off `globalThis.__caramelTestExports` —
 * explicit capture, not reliance on global leakage. Each file keeps its OWN
 * separate `(0, eval)()` call (needed so per-file top-level hoisting stays
 * accurate to the real separate-<script> model — see caramel-base.js's
 * relocated `_isDevInstall`), but a small capture epilogue is appended to
 * EVERY file's own eval call, not run once at the end: verified empirically
 * (this jsdom environment) that indirect eval's top-level `function`/`var`
 * become real `globalThis` properties (visible from ANY later, separate
 * eval call — safe to capture at the end), but top-level `const`/`let` do
 * NOT survive into a later, separate `(0, eval)()` call the way they would
 * inside one continuous script — they must be read back within the SAME
 * eval call as the file that declares them (e.g. coupon-fetch.js's
 * `const RESTRICTED_STATUSES`). Running the (idempotent, guarded) capture
 * attempt after every file, rather than trying to know in advance which
 * file defines which name, keeps this a plain ordered file list.
 *
 * @param {string[]} fileNames - source files relative to the extension
 *   root, in load order.
 * @param {string[]} exportNames - identifiers to capture (from wherever
 *   among fileNames they're actually declared).
 * @returns {Record<string, unknown>} the captured bindings
 */
export function loadExtensionSources(fileNames, exportNames) {
    installChromeStub()
    globalThis.__caramelTestExports = {}

    const captureEpilogue = exportNames
        .map(
            name =>
                `if (typeof ${name} !== 'undefined') { globalThis.__caramelTestExports[${JSON.stringify(name)}] = ${name} }`,
        )
        .join('\n')

    for (const fileName of fileNames) {
        const src = readFileSync(path.join(EXT_ROOT, fileName), 'utf8')
        // <script>-global source file the same way the browser would, plus
        // this SAME call's capture attempt (see doc comment above for why
        // it can't be deferred to a later, separate eval call).
        ;(0, eval)(src + '\n' + captureEpilogue)
    }

    const missing = exportNames.filter(
        name => !(name in globalThis.__caramelTestExports),
    )
    if (missing.length) {
        throw new ReferenceError(
            `loadExtensionSources(${JSON.stringify(fileNames)}): none of the loaded files define ${missing.join(', ')}`,
        )
    }

    return globalThis.__caramelTestExports
}

/**
 * Reads `fileName` from the extension root and evaluates it via indirect
 * eval (global scope, matching how a <script> tag would run it). Appends a
 * capture expression so callers grab exactly the bindings they need off
 * `globalThis.__caramelTestExports` — explicit capture, not reliance on
 * global leakage from the eval'd top-level var/function declarations.
 *
 * Single-file convenience wrapper around loadExtensionSources() — installs
 * its OWN fresh chrome stub (matches every existing call site, which loads
 * one self-contained file at a time and expects a clean stub).
 *
 * @param {string} fileName - source file relative to the extension root
 * @param {string[]} exportNames - identifiers to capture after evaluating
 * @returns {Record<string, unknown>} the captured bindings
 */
export function loadExtensionSource(fileName, exportNames) {
    return loadExtensionSources([fileName], exportNames)
}
