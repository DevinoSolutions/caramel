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
    // Apply-flow debug telemetry (coupon-apply.js / coupon-fetch.js call
    // this). No in-extension reader — inspected manually via storage on dev
    // installs — so the log is capped to the newest entries at write time
    // (same policy as CARAMEL_SAVINGS_MAX) instead of growing forever.
    const CARAMEL_TIMINGS_MAX = 50
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
                    currentBrowser.storage.local.set({
                        caramel_timings: arr.slice(-CARAMEL_TIMINGS_MAX),
                    })
                })
            }
        } catch {
            // ignore storage errors
        }
    }
}

// The error counterpart to `log`, and it exists for the same reason `log` is
// gated: content scripts run on https://*/*, so anything printed here lands in
// a STORE's console on a shopper's machine. Three raw console.error calls used
// to do exactly that — one of them ("applyCoupon error") without even naming
// Caramel, so a store owner reading their own console had no way to tell whose
// bug they were looking at.
//
// Silencing the console is NOT swallowing the failure: every call still writes
// a capped storage entry, which is the same place the apply-flow timings are
// read from on a dev install. Loud where we can read it, quiet on a stranger's
// page.
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
if (typeof logError === 'undefined') {
    var logError = (where, err) => {
        try {
            recordTiming('ERROR', {
                where,
                message: String(err?.message || err).slice(0, 300),
            })
        } catch {
            // recording is best-effort; never let it mask the original error
        }
        if (_isDevInstall()) console.error('Caramel:', where, err)
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
    'https://www.grabcaramel.com',
    ...(_isDevInstall()
        ? ['http://localhost:58000', 'https://dev.grabcaramel.com']
        : []),
])

/* --------------------------------------------------  session storage */
// The bearer we get from /api/extension/login and the OAuth exchange IS a full
// website session token, not an extension-scoped one. It belongs in
// storage.LOCAL: Chrome Sync replicates storage.sync to Google's servers and
// back down to every Chrome profile signed into the same Google account, so a
// credential kept there roams far past the machine that signed in — one
// borrowed laptop with the same Chrome profile inherits a live session.
// Settings above stay in sync deliberately; preferences SHOULD roam, a
// credential should not.
//
// Reads migrate transparently: anything already in sync (every user who
// installed before this change) is copied to local and deleted from sync the
// next time it is read, so nobody gets silently logged out and the roamed copy
// stops being replicated. background.js has a read-only twin of this fallback —
// it is a service worker and cannot load this file.
const CARAMEL_SESSION_KEYS = ['token', 'user']

// Cross-file content-script/popup reads — per-file analysis can't see them.
// oxlint-disable-next-line no-unused-vars
function caramelGetSession() {
    return new Promise(resolve => {
        try {
            currentBrowser.storage.local.get(CARAMEL_SESSION_KEYS, local => {
                if (local?.token) {
                    resolve({ token: local.token, user: local.user || null })
                    return
                }
                // Pre-migration install: adopt the synced credential, then stop
                // syncing it. Best-effort — a storage error must not sign
                // anyone out, so the session is returned either way.
                currentBrowser.storage.sync.get(
                    CARAMEL_SESSION_KEYS,
                    synced => {
                        if (!synced?.token) {
                            resolve({ token: null, user: null })
                            return
                        }
                        const adopted = {
                            token: synced.token,
                            user: synced.user || null,
                        }
                        currentBrowser.storage.local.set(adopted, () => {
                            currentBrowser.storage.sync.remove(
                                CARAMEL_SESSION_KEYS,
                                () => resolve(adopted),
                            )
                        })
                    },
                )
            })
        } catch {
            resolve({ token: null, user: null })
        }
    })
}

// oxlint-disable-next-line no-unused-vars
function caramelSetSession(session, done) {
    const cb = typeof done === 'function' ? done : () => {}
    try {
        currentBrowser.storage.local.set(
            { token: session.token, user: session.user || null },
            () =>
                // Clear any pre-migration synced copy in the same breath, so a
                // fresh login never leaves the old roaming credential behind.
                currentBrowser.storage.sync.remove(CARAMEL_SESSION_KEYS, cb),
        )
    } catch {
        cb()
    }
}

// oxlint-disable-next-line no-unused-vars
function caramelClearSession(done) {
    const cb = typeof done === 'function' ? done : () => {}
    try {
        currentBrowser.storage.local.remove(CARAMEL_SESSION_KEYS, () =>
            currentBrowser.storage.sync.remove(CARAMEL_SESSION_KEYS, cb),
        )
    } catch {
        cb()
    }
}

/* --------------------------------------------------  user settings */
// One storage.sync object so preferences roam with the browser profile.
// Shape: { autoApply: boolean, disabledSites: string[] } — read through
// this helper only, so defaults live in exactly one place.
const CARAMEL_SETTINGS_KEY = 'caramel_settings'
// Cross-file content-script/popup reads — per-file analysis can't see them.
// oxlint-disable-next-line no-unused-vars
function caramelGetSettings() {
    return new Promise(resolve => {
        try {
            currentBrowser.storage.sync.get([CARAMEL_SETTINGS_KEY], res => {
                const s = (res && res[CARAMEL_SETTINGS_KEY]) || {}
                resolve({
                    autoApply: s.autoApply !== false,
                    disabledSites: Array.isArray(s.disabledSites)
                        ? s.disabledSites
                        : [],
                })
            })
        } catch {
            resolve({ autoApply: true, disabledSites: [] })
        }
    })
}
// oxlint-disable-next-line no-unused-vars
async function caramelSetSettings(patch) {
    const cur = await caramelGetSettings()
    const next = Object.assign({}, cur, patch)
    return new Promise(resolve => {
        try {
            currentBrowser.storage.sync.set(
                { [CARAMEL_SETTINGS_KEY]: next },
                () => resolve(next),
            )
        } catch {
            resolve(next)
        }
    })
}
// Should the passive checkout prompt appear on this host? False when the
// user turned auto-apply off globally or paused this site. The popup's
// explicit "apply coupons" action deliberately does NOT go through this.
// oxlint-disable-next-line no-unused-vars
async function caramelPromptAllowed(host) {
    const s = await caramelGetSettings()
    if (!s.autoApply) return false
    const h = String(host || '')
        .toLowerCase()
        .replace(/^www\./, '')
    return !s.disabledSites.some(d => h === d || h.endsWith('.' + d))
}

/* --------------------------------------------------  savings history */
// Local (not synced — can exceed sync quotas) list of confirmed savings,
// newest first, capped. Read by the popup's "you've saved" summary.
const CARAMEL_SAVINGS_KEY = 'caramel_savings'
const CARAMEL_SAVINGS_MAX = 50

/* Whose saving is this?
 *
 * The history is a shopping record — store names, codes, amounts — and it used
 * to be one undifferentiated device-wide list. Log out and hand the laptop to
 * someone else, and they read your last fifty purchases in the popup. Nobody
 * signs out expecting that.
 *
 * Entries recorded while signed in are stamped with the account, and only that
 * account sees them again. Entries recorded signed OUT carry no stamp and stay
 * visible to whoever is using the browser — they were earned by this device,
 * with nobody logged in, and hiding them would mean a guest's own savings
 * vanish for no reason they could name.
 *
 * Nothing is ever deleted. Signing in therefore keeps the history you built as
 * a guest, and signing out simply puts your account's entries away.
 */
function _caramelSavingsOwner(entry) {
    return entry && typeof entry.u === 'string' && entry.u ? entry.u : null
}
function _caramelSavingsVisibleTo(list, username) {
    const me = username || null
    return (Array.isArray(list) ? list : []).filter(e => {
        const owner = _caramelSavingsOwner(e)
        return owner === null || owner === me
    })
}
/* Reads the history as the CURRENT identity sees it. Pass `{ all: true }` only
 * where every entry is genuinely wanted (the record itself, never the UI). */
// oxlint-disable-next-line no-unused-vars
function caramelGetSavings(options) {
    const wantAll = !!(options && options.all)
    return new Promise(resolve => {
        try {
            currentBrowser.storage.local.get([CARAMEL_SAVINGS_KEY], res => {
                const arr = res && res[CARAMEL_SAVINGS_KEY]
                const list = Array.isArray(arr) ? arr : []
                if (wantAll) {
                    resolve(list)
                    return
                }
                caramelGetSession()
                    .then(session =>
                        resolve(
                            _caramelSavingsVisibleTo(
                                list,
                                session?.user?.username || null,
                            ),
                        ),
                    )
                    .catch(() => resolve(_caramelSavingsVisibleTo(list, null)))
            })
        } catch {
            resolve([])
        }
    })
}
// entry: { domain, code, amount, currency, t } — amount must be a real
// measured saving (> 0); applied-but-unmeasured codes are not recorded.
// oxlint-disable-next-line no-unused-vars
async function caramelRecordSaving(entry) {
    if (!entry || !(entry.amount > 0)) return
    // The WHOLE list, not the visible slice: reading through the identity
    // filter here would drop everyone else's entries on the next write.
    const list = await caramelGetSavings({ all: true })
    const session = await caramelGetSession().catch(() => null)
    const owner = session?.user?.username || null
    list.unshift({
        domain: String(entry.domain || ''),
        code: String(entry.code || ''),
        amount: Math.round(entry.amount * 100) / 100,
        currency: String(entry.currency || 'USD'),
        t: entry.t || Date.now(),
        // Absent for a signed-out saving — see _caramelSavingsVisibleTo.
        ...(owner ? { u: owner } : {}),
    })
    return new Promise(resolve => {
        try {
            currentBrowser.storage.local.set(
                { [CARAMEL_SAVINGS_KEY]: list.slice(0, CARAMEL_SAVINGS_MAX) },
                resolve,
            )
        } catch {
            resolve()
        }
    })
}
