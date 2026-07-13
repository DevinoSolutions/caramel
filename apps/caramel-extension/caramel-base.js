// owns: bootstrap (currentBrowser + double-load guard), sleep/log/recordTiming fallbacks, CARAMEL_ALLOWED_ORIGINS, _isDevInstall (relocated from store-detect.js — see F-008 note below)
// load after: (nothing — loads first)
//
// F-008 note: _isDevInstall (defined below, right after the bootstrap
// block) was reassigned here from store-detect.js's "config cache" section
// during the shared-utils.js split. This file's own top-level
// log()/CARAMEL_ALLOWED_ORIGINS initializers call it immediately at load
// time — same-script hoisting made that resolve when everything was one
// file; splitting into separate <script>-equivalent files does NOT hoist
// backward across files, so the definition had to move earlier than its
// original position. store-detect.js's _getCacheTtl() still calls it too,
// but only from inside a function body (deferred), so it doesn't care
// which split file actually defines the global — only that some
// earlier-loading file does. Verified: an isolated-vm prefix-load check
// (each file eval'd separately, in manifest order, fresh realm) throws
// ReferenceError at this file without the move, and is clean with it.

/********************************************************************
 * Caramel core logic – 2025-06-29  (speed-tuned)
 ********************************************************************/

/* --------------------------------------------------  bootstrap */
// Track script loading to prevent redeclaration errors on multiple loads
if (typeof window !== 'undefined') {
    if (window.__caramel_shared_utils_loaded) {
        // Script already loaded - use existing window.currentBrowser
        // Don't redeclare to avoid errors
    } else {
        window.__caramel_shared_utils_loaded = true

        // First load - create currentBrowser on window
        window.currentBrowser = (() => {
            if (typeof chrome !== 'undefined') return chrome
            if (typeof browser !== 'undefined') return browser
            throw new Error('Browser is not supported!')
        })()
    }
    // Ensure window.currentBrowser exists
    if (!window.currentBrowser) {
        window.currentBrowser = (() => {
            if (typeof chrome !== 'undefined') return chrome
            if (typeof browser !== 'undefined') return browser
            throw new Error('Browser is not supported!')
        })()
    }
    // Create local reference - var allows redeclaration, so this is safe even on second load
    var currentBrowser = window.currentBrowser
} else {
    // Non-window environment (service worker) - safe to declare normally
    var currentBrowser = (() => {
        if (typeof chrome !== 'undefined') return chrome
        if (typeof browser !== 'undefined') return browser
        throw new Error('Browser is not supported!')
    })()
}

// Dev-mode detection that works in BOTH popup AND content-script contexts.
// chrome.management only exists in the service worker, but
// chrome.runtime.getManifest() works everywhere.
// Production (Chrome Web Store) installs have an `update_url` field;
// unpacked dev extensions don't.
function _isDevInstall() {
    try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest)
            return false
        const m = chrome.runtime.getManifest()
        return !m.update_url
    } catch {
        return false
    }
}

/* --------------------------------------------------  tiny helpers */
// Check if already declared to prevent redeclaration errors on script reload
if (typeof sleep === 'undefined') {
    var sleep = ms => new Promise(r => setTimeout(r, ms))
}
if (typeof log === 'undefined') {
    // Verbose only on unpacked dev installs; silent in the packed Web Store
    // build so we don't leak coupon/flow internals into every store's console.
    var log = _isDevInstall()
        ? (...a) => console.log('Caramel:', ...a)
        : () => {}
}
if (typeof recordTiming === 'undefined') {
    var recordTiming = (event, meta = {}) => {
        try {
            const entry = { event, t: performance.now(), meta }
            if (
                currentBrowser &&
                currentBrowser.storage &&
                currentBrowser.storage.local
            ) {
                currentBrowser.storage.local.get(['caramel_timings'], res => {
                    const arr = (res && res.caramel_timings) || []
                    arr.push(entry)
                    currentBrowser.storage.local.set({ caramel_timings: arr })
                })
            }
        } catch {
            // ignore storage errors
        }
    }
}

// Origins trusted to inject a login token via window.postMessage. The dev
// origins are ONLY trusted on an unpacked dev install — in the packed Web Store
// build a tab on dev.grabcaramel.com or a local server must NOT be able to write
// credentials into a real user's extension storage.
// Read from coupon-runner.js's message listener (cross-file content-script
// reference — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
const CARAMEL_ALLOWED_ORIGINS = new Set([
    'https://grabcaramel.com',
    ...(_isDevInstall()
        ? ['http://localhost:58300', 'https://dev.grabcaramel.com']
        : []),
])
