// owns: bootstrap (currentBrowser + double-load guard), sleep/log/recordTiming/
// logError, CARAMEL_ALLOWED_ORIGINS, session/settings/savings storage
//
// ES module since the WXT P1 port (2026-08-12). CARAMEL_ENV now arrives by
// import rather than by load order: the module graph gives structurally what
// the old "load after: caramel-env.js" note asked the manifest ordering to
// guarantee by hand, so this file's top-level log()/CARAMEL_ALLOWED_ORIGINS
// initializers still read a fully-evaluated stamp.
//
// The bootstrap block is this file's ONLY top-level side effect, so it moved
// into the exported initCaramelBase(): WXT imports entrypoints in Node at build
// time to read their options, and resolving `chrome`/`browser` — or throwing
// 'Browser is not supported!' — during module evaluation would run there too.
// `currentBrowser` is therefore a module-scope binding that init assigns. Every
// helper below closes over it and reads it at CALL time, and importers share the
// same live binding, so it may never be read during an importer's OWN top-level
// initialization — only from inside a function.
//
// F-008 note: _isDevInstall used to be defined here, right after the
// bootstrap block, having been relocated from store-detect.js for exactly
// the load-order reason above. It is gone: it decided dev-vs-production by
// the absence of a manifest `update_url`, which only the Chrome Web Store
// injects, so every Firefox and Safari build answered "dev". That answer is
// now made at BUILD time and read from CARAMEL_ENV — see the environment
// table in scripts/environments.mjs.

import { CARAMEL_ENV } from './caramel-env.js'

/********************************************************************
 * Caramel core logic – 2025-06-29  (speed-tuned)
 ********************************************************************/

/* --------------------------------------------------  bootstrap */
// Assigned by initCaramelBase() — see the header note.
export let currentBrowser

// Track script loading to prevent redeclaration errors on multiple loads
export function initCaramelBase() {
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
        // Local reference — this module's helpers and its importers read it.
        currentBrowser = window.currentBrowser
    } else {
        // Non-window environment (service worker)
        currentBrowser = (() => {
            if (typeof chrome !== 'undefined') return chrome
            if (typeof browser !== 'undefined') return browser
            throw new Error('Browser is not supported!')
        })()
    }
}

/* --------------------------------------------------  tiny helpers */
// sleep/log/recordTiming/logError were guarded `var`s
// (`if (typeof sleep === 'undefined') { var sleep = … }`) so a re-injected
// content script could not redeclare a global. The guards are gone with the
// globals: a module evaluates once per realm, and under ESM the `typeof` test
// resolves against this module's own hoisted binding, so it would answer
// "undefined" every time — a vacuous guard. Nothing else in either realm
// declares these names, so the unconditional declaration is exactly what the
// guard produced on every real load.
export const sleep = ms => new Promise(r => setTimeout(r, ms))

// Verbose only in a build stamped for development; silent in every shipped
// build so we don't leak coupon/flow internals into a store's console.
export const log = CARAMEL_ENV.verbose
    ? (...a) => console.log('Caramel:', ...a)
    : () => {}

// Apply-flow debug telemetry (coupon-apply.js / coupon-fetch.js call
// this). No in-extension reader — inspected manually via storage on dev
// installs — so the log is capped to the newest entries at write time
// (same policy as CARAMEL_SAVINGS_MAX) instead of growing forever.
const CARAMEL_TIMINGS_MAX = 50
export const recordTiming = (event, meta = {}) => {
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
export const logError = (where, err) => {
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

export function caramelSendMessage(message, timeoutMs) {
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
// Read from coupon-runner.js's message listener.
export const CARAMEL_ALLOWED_ORIGINS = new Set(CARAMEL_ENV.trustedOrigins)

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

export function caramelGetSession() {
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

export function caramelSetSession(session, done) {
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

export function caramelClearSession(done) {
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
// Shape: { autoApply: boolean, disabledSites: string[], syncSavings: boolean }
// — read through this helper only, so defaults live in exactly one place.
//
// `syncSavings` DEFAULTS FALSE, and unlike `autoApply` it is written as
// `=== true` rather than `!== false`: an absent key must read as "has not
// opted in". This flag is consent to upload a shopping record, so a default
// that treated silence as yes would be consent nobody gave. The account-side
// authority is users.savings_sync_enabled; this is the roaming cache of it.
const CARAMEL_SETTINGS_KEY = 'caramel_settings'

export function caramelGetSettings() {
    return new Promise(resolve => {
        try {
            currentBrowser.storage.sync.get([CARAMEL_SETTINGS_KEY], res => {
                const s = (res && res[CARAMEL_SETTINGS_KEY]) || {}
                resolve({
                    autoApply: s.autoApply !== false,
                    disabledSites: Array.isArray(s.disabledSites)
                        ? s.disabledSites
                        : [],
                    syncSavings: s.syncSavings === true,
                })
            })
        } catch {
            resolve({
                autoApply: true,
                disabledSites: [],
                syncSavings: false,
            })
        }
    })
}

export async function caramelSetSettings(patch) {
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
export async function caramelPromptAllowed(host) {
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
export function caramelGetSavings(options) {
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
/* Stable id for one saving, minted once and never regenerated: it is the
 * idempotency key POST /api/account/savings dedupes on, so a RETRY must carry
 * the value the first attempt did. Stamped at record time; sync only reads it.
 *
 * crypto.randomUUID() is missing in an INSECURE context and a plain http://
 * checkout is one, so it is feature-detected, falling back to getRandomValues
 * (which IS available there) and then to Math.random — a weak id still works as
 * an idempotency key, where a thrown TypeError would lose the saving.
 */
function _caramelNewEventId() {
    try {
        if (
            globalThis.crypto &&
            typeof globalThis.crypto.randomUUID === 'function'
        ) {
            return globalThis.crypto.randomUUID()
        }
        if (
            globalThis.crypto &&
            typeof globalThis.crypto.getRandomValues === 'function'
        ) {
            const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
            bytes[6] = (bytes[6] & 0x0f) | 0x40
            bytes[8] = (bytes[8] & 0x3f) | 0x80
            const hex = Array.from(bytes, b =>
                b.toString(16).padStart(2, '0'),
            ).join('')
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
        }
    } catch {
        // fall through to the arithmetic id below
    }
    return `caramel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/* Applies CARAMEL_SAVINGS_MAX, evicting SYNCED entries before unsynced ones.
 *
 * A blind newest-50 trim can evict an entry that never reached the server,
 * deleting the only copy that ever existed. A synced entry is safe on the
 * account and costs nothing to drop locally, so those go first, oldest first.
 *
 * When EVERY entry is unsynced (a long outage, or a shopper who never opted in)
 * the oldest is dropped. That is a real loss, so it goes through logError
 * rather than passing in silence: it is the one path in the savings history
 * where data leaves and does not come back.
 */
function _caramelTrimSavings(list) {
    if (list.length <= CARAMEL_SAVINGS_MAX) return list
    const keep = list.slice()
    for (
        let i = keep.length - 1;
        i >= 0 && keep.length > CARAMEL_SAVINGS_MAX;
        i--
    ) {
        if (keep[i] && (keep[i].synced || keep[i].syncRejected))
            keep.splice(i, 1)
    }
    if (keep.length > CARAMEL_SAVINGS_MAX) {
        logError(
            'savings cap evicted unsynced entries',
            `dropped ${keep.length - CARAMEL_SAVINGS_MAX} saving(s) that never reached the server`,
        )
        return keep.slice(0, CARAMEL_SAVINGS_MAX)
    }
    return keep
}

function _caramelWriteSavings(list) {
    return new Promise(resolve => {
        try {
            currentBrowser.storage.local.set(
                { [CARAMEL_SAVINGS_KEY]: _caramelTrimSavings(list) },
                resolve,
            )
        } catch {
            resolve()
        }
    })
}

// entry: { domain, code, amount, currency, t, couponId } — amount must be a
// real measured saving (> 0); applied-but-unmeasured codes are not recorded.
export async function caramelRecordSaving(entry) {
    if (!entry || !(entry.amount > 0)) return
    // The WHOLE list, not the visible slice: reading through the identity
    // filter here would drop everyone else's entries on the next write.
    const list = await caramelGetSavings({ all: true })
    const session = await caramelGetSession().catch(() => null)
    const owner = session?.user?.username || null
    const settings = await caramelGetSettings()

    /* Eligibility is decided here, once, and frozen onto the entry rather than
     * re-derived at sweep time from whatever the settings then say. Two
     * promises depend on it: "sync starts from here" (turning the switch on
     * must not retroactively upload savings earned while it was off), and a
     * saving earned SIGNED OUT belongs to the device, not to the next account
     * that signs in — no owner, no upload.
     */
    const syncPending = !!(settings.syncSavings && session?.token && owner)

    list.unshift({
        domain: String(entry.domain || ''),
        code: String(entry.code || ''),
        amount: Math.round(entry.amount * 100) / 100,
        currency: String(entry.currency || 'USD'),
        t: entry.t || Date.now(),
        // Stamped on EVERY entry, syncable or not: it costs one call, and an
        // entry that acquires an id only when it becomes eligible could not be
        // retried idempotently the first time.
        clientEventId: _caramelNewEventId(),
        // The catalog coupon this win came from. The call sites hold it (they
        // already pass it to the trust-loop report) and used to drop it, which
        // left the account-side event unable to name the code's source.
        ...(entry.couponId ? { couponId: String(entry.couponId) } : {}),
        // Absent for a signed-out saving — see _caramelSavingsVisibleTo.
        ...(owner ? { u: owner } : {}),
        ...(syncPending ? { syncPending: true } : {}),
    })
    await _caramelWriteSavings(list)

    // Deliberately not awaited: the saving is already banked locally and the
    // money path must not wait on a round-trip to show the shopper their
    // result. The result IS checked — caramelSyncSavings marks what the server
    // confirmed and leaves the rest queued — just not here.
    if (syncPending) caramelSyncSavings()
}

/* --------------------------------------------------  savings cloud sync */
// Server-side batch cap is 100; 50 matches the local history cap, so a full
// catch-up sweep is one request.
const CARAMEL_SYNC_BATCH_MAX = 50

/* One flush at a time. Two callers race by design — the recording moment fires
 * one, opening the popup fires a catch-up sweep — and both read the history,
 * push, then write the marks back, so two in flight can lose the other's mark
 * (last write wins on the whole array). Duplicate EVENTS stay impossible either
 * way (clientEventId is unique server-side), but a lost mark means re-pushing
 * an entry forever. Collapsing onto one promise is cheaper than making the
 * read-modify-write atomic.
 */
let _caramelSyncInFlight = null

/* Pushes queued savings to the account. Never throws and never surfaces
 * anything to the shopper — a failed background sync is not worth interrupting
 * checkout for; failures stay queued for the next attempt and go to logError.
 * Resolves to { pushed, rejected, skipped } so callers and tests can see what
 * happened instead of inferring it from storage.
 */
export function caramelSyncSavings() {
    if (_caramelSyncInFlight) return _caramelSyncInFlight
    _caramelSyncInFlight = _caramelSyncSavingsOnce().finally(() => {
        _caramelSyncInFlight = null
    })
    return _caramelSyncInFlight
}

async function _caramelSyncSavingsOnce() {
    const settings = await caramelGetSettings()
    if (!settings.syncSavings) return { pushed: 0, skipped: 'sync-off' }

    const session = await caramelGetSession().catch(() => null)
    const owner = session?.user?.username || null
    if (!session?.token || !owner) return { pushed: 0, skipped: 'signed-out' }

    const list = await caramelGetSavings({ all: true })
    const queue = list.filter(
        e =>
            e &&
            e.syncPending &&
            !e.synced &&
            !e.syncRejected &&
            e.clientEventId &&
            // Only this account's entries. A guest entry has no owner and must
            // not be attributed to whoever happens to be signed in now.
            e.u === owner,
    )
    if (!queue.length) return { pushed: 0, skipped: 'nothing-queued' }

    const batch = queue.slice(0, CARAMEL_SYNC_BATCH_MAX)
    let response
    try {
        response = await caramelSendMessage({
            action: 'syncSavings',
            events: batch.map(e => ({
                clientEventId: e.clientEventId,
                store: e.domain,
                code: e.code || '',
                couponId: e.couponId || null,
                // Integer minor units on the wire — the stored `amount` is a
                // 2-decimal float and floats are not what a total gets summed
                // from.
                amountCents: Math.round(e.amount * 100),
                currency: e.currency || 'USD',
                occurredAt: new Date(e.t).toISOString(),
            })),
        })
    } catch (err) {
        logError('syncSavings transport', err)
        return { pushed: 0, error: String(err) }
    }
    // The ACCOUNT says sync is off and this device's setting was stale. The
    // server owns consent, so this is an answer, not a failure — retrying it
    // would ask the same question on every popup open forever, and the answer
    // can only change through caramelSetSettings, which re-arms the sweep.
    //
    // Two writes, neither a sync: reconcile the cached setting (the next sweep
    // then short-circuits at 'sync-off' before building a batch), and clear
    // syncPending on everything queued for this account so it stays device-
    // local. That keeps the "sync starts from here" promise — consenting later
    // uploads what follows, never a backlog recorded while consent was off.
    // Nothing is marked `synced` (nothing was stored) and nothing is marked
    // `syncRejected` (the events are fine; the permission was missing).
    if (response && response.error === 'savings_sync_disabled') {
        await caramelSetSettings({ syncSavings: false })
        const pendingIds = new Set(queue.map(e => e.clientEventId))
        const current = await caramelGetSavings({ all: true })
        for (const e of current) {
            if (e && e.clientEventId && pendingIds.has(e.clientEventId)) {
                delete e.syncPending
            }
        }
        await _caramelWriteSavings(current)
        logError(
            'syncSavings',
            `account has savings sync off — un-queued ${pendingIds.size} device-local entries`,
        )
        return { pushed: 0, skipped: 'sync-disabled-by-account' }
    }
    if (!response || response.error) {
        logError('syncSavings', response?.error || 'no response')
        return { pushed: 0, error: response?.error || 'no response' }
    }

    const stored = new Set(
        Array.isArray(response.stored) ? response.stored : [],
    )
    const rejected = new Map(
        (Array.isArray(response.rejected) ? response.rejected : [])
            .filter(r => r && r.clientEventId)
            .map(r => [r.clientEventId, String(r.reason || 'rejected')]),
    )

    // Re-read rather than reusing `list`: the money path may have unshifted a
    // new saving while this request was in flight, and writing the stale array
    // back would erase it.
    const fresh = await caramelGetSavings({ all: true })
    for (const e of fresh) {
        if (!e || !e.clientEventId) continue
        if (stored.has(e.clientEventId)) {
            e.synced = true
        } else if (rejected.has(e.clientEventId)) {
            // The server will refuse this payload every time — validation is
            // deterministic — so retrying it forever would be a poison pill at
            // the head of the queue. Mark it, keep it (the shopper's local
            // history is unchanged), and record why.
            e.syncRejected = rejected.get(e.clientEventId)
            logError('syncSavings rejected an event', e.syncRejected)
        }
    }
    await _caramelWriteSavings(fresh)

    return { pushed: stored.size, rejected: rejected.size }
}
