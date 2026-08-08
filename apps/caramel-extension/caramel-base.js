// owns: bootstrap (currentBrowser + double-load guard), sleep/log/recordTiming fallbacks, CARAMEL_ALLOWED_ORIGINS
// load after: caramel-env.js (the build-time environment stamp — this file's
// own top-level log()/CARAMEL_ALLOWED_ORIGINS initializers read CARAMEL_ENV
// immediately at load time, and separate <script>-equivalent files do NOT
// hoist backward across each other)
//
// F-008 note: _isDevInstall used to be defined here, right after the
// bootstrap block, having been relocated from store-detect.js for exactly
// the load-order reason above. It is gone: it decided dev-vs-production by
// the absence of a manifest `update_url`, which only the Chrome Web Store
// injects, so every Firefox and Safari build answered "dev". That answer is
// now made at BUILD time and read from CARAMEL_ENV — see the "environment"
// block in scripts/build-dist.mjs.

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

/* --------------------------------------------------  tiny helpers */
// Check if already declared to prevent redeclaration errors on script reload
if (typeof sleep === 'undefined') {
    var sleep = ms => new Promise(r => setTimeout(r, ms))
}
if (typeof log === 'undefined') {
    // Verbose only in a build stamped for development; silent in every shipped
    // build so we don't leak coupon/flow internals into a store's console.
    var log = CARAMEL_ENV.verbose
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
        if (CARAMEL_ENV.verbose) console.error('Caramel:', where, err)
    }
}

/* --------------------------------------------------  worker messaging */
// Every content-script call into the background worker used to be written as
// `await new Promise(res => runtime.sendMessage(msg, res))`, which has two
// failure modes that both end in SILENCE:
//
//   1. The MV3 worker is evicted mid-flight. Chrome closes the port without
//      invoking sendResponse, the callback fires with `undefined` and sets
//      runtime.lastError. Nobody read lastError, so `undefined` flowed on as
//      if it were a reply and `resp?.coupons || []` became an empty list —
//      indistinguishable from "this store has no coupons".
//   2. Nothing answers at all. There was no timeout, so the promise never
//      settled and the whole apply flow parked forever with no error.
//
// Measured on 2026-08-07: on a live cart the trail ended at
// AUTO_INSERT_FETCHCOUPONS_START and no END line — either branch, no
// diagnostics. This wrapper turns both into a rejection the caller can see.
//
// The budget must sit ABOVE the worker's own fetch budget, or we abandon a
// request the worker is still legitimately serving. background.js defaults to
// 8s per call, so 15s is the floor here; the bulk supported-stores call runs
// on a 30s budget there and passes a correspondingly larger value.
const CARAMEL_MESSAGE_TIMEOUT_MS = 15000

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
function caramelSendMessage(message, timeoutMs) {
    const budget = timeoutMs || CARAMEL_MESSAGE_TIMEOUT_MS
    const action = message?.action || 'unknown'
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = fn => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            fn()
        }
        const timer = setTimeout(
            () =>
                finish(() =>
                    reject(
                        new Error(
                            `caramel: no response to "${action}" within ${budget}ms`,
                        ),
                    ),
                ),
            budget,
        )
        try {
            currentBrowser.runtime.sendMessage(message, resp => {
                finish(() => {
                    // Reading lastError is what makes an evicted worker
                    // visible; leaving it unread also makes Chrome log it as
                    // an unchecked error.
                    const portError = currentBrowser.runtime.lastError
                    if (portError) {
                        reject(
                            new Error(
                                `caramel: "${action}" port closed — ${portError.message || portError}`,
                            ),
                        )
                        return
                    }
                    if (resp === undefined) {
                        reject(
                            new Error(
                                `caramel: "${action}" returned no response`,
                            ),
                        )
                        return
                    }
                    resolve(resp)
                })
            })
        } catch (err) {
            finish(() => reject(err))
        }
    })
}

// Origins trusted to inject a login token via window.postMessage — decided by
// the build, and matching the deployment this build actually talks to.
//
// It used to be the two production origins ALWAYS, plus the dev pair when
// `_isDevInstall()` said so, which was wrong in both directions. A Firefox or
// Safari build (no manifest update_url, so "dev" by that heuristic) shipped
// trusting a local server and the dev site to write credentials into a real
// user's extension storage; and a build pointed at dev still trusted a prod tab
// to hand it a PRODUCTION session, which is a token crossing an environment
// boundary the rest of the extension respects.
//
// Read from coupon-runner.js's message listener (cross-file content-script
// reference — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
const CARAMEL_ALLOWED_ORIGINS = new Set(CARAMEL_ENV.trustedOrigins)

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
