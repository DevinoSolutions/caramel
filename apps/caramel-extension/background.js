// ES module since the WXT P1 port (2026-08-12). The build-time environment
// stamp now arrives as a static import, replacing the old
// `if (typeof importScripts === 'function') importScripts('/caramel-env.js')`
// header. That guard existed because this one file runs in two kinds of
// background context — Chrome and Safari run it as an MV3 service worker,
// where importScripts loads siblings; Firefox runs it as a background script
// and lists caramel-env.js ahead of it in manifest-firefox.json, where
// importScripts does not exist. The module graph makes the stamp a dependency
// edge rather than a per-browser loading trick, so both contexts still have it
// in place before the first message is handled, with no branch to get wrong.
//
// Every top-level statement that DID something — resolving the browser handle,
// the keep-alive, the badge styling, and the three listener registrations —
// moved, in its original order, into initBackground(). The WXT entrypoint calls
// that synchronously at worker start, which is what MV3 requires of listener
// registration. What is left at module scope is inert declarations, so WXT can
// import this file in Node at build time to read the entrypoint's options.
import { CARAMEL_BASE_URL, CARAMEL_ENV } from './caramel-env.js'

// Assigned by initBackground() instead of at module evaluation: the IIFE throws
// when neither global exists, which is exactly the case in the Node import
// above. Every reader below sits in a function body that runs after init, so
// the value each one sees is unchanged.
let currentBrowser

const caramelUrl = path => new URL(path, `${CARAMEL_BASE_URL}/`).toString()

// Same policy as `logError` in caramel-base.js, which the service worker
// cannot share (separate context, no content-script files loaded here): a
// shipped build prints nothing anywhere, and the failure is still recorded
// where a development build can read it back. These reach only our own worker
// console rather than a store's page, so the leak is smaller — but "quiet
// unless it's my build" is worth being one rule instead of two.
const CARAMEL_BG_ERRORS_MAX = 30
const logError = (where, err) => {
    try {
        currentBrowser.storage?.local?.get(['caramel_bg_errors'], res => {
            const arr = (res && res.caramel_bg_errors) || []
            arr.push({
                where,
                message: String(err?.message || err).slice(0, 300),
                t: Date.now(),
            })
            currentBrowser.storage.local.set({
                caramel_bg_errors: arr.slice(-CARAMEL_BG_ERRORS_MAX),
            })
        })
    } catch {
        // recording is best-effort; never let it mask the original error
    }
    if (CARAMEL_ENV.verbose) console.error('Caramel:', where, err)
}

/* How many coupons one fetchCoupons request asks for. The number the popup
 * paginates in, and the number the apply flow works from on its first (usually
 * only) page. 20 has always been this value; it lives in a named constant now
 * because a second caller — the popup's next-page request — has to agree with
 * it, and the route's own ceiling is 50. */
const COUPON_PAGE_SIZE = 20

const FETCH_TIMEOUT_MS = 8000
// One budget does not fit both shapes of call we make. The store list is a
// bulk payload (~1.14 MB, 2670 stores) and the small JSON calls are a few KB.
//
// Measured 2026-08-07, same browser, same instant: an ordinary page fetched
// the store list in ~620 ms while THIS service worker took 6.7 s on a warm
// connection and over 60 s on its first, cold one — reproduced across two
// runs. At 8 s the cold fetch aborted every time, and because an abort is
// reported downstream as an empty list rather than an error, the extension
// went silent on every store at once with nothing logged anywhere.
//
// So: keep 8 s as the default for the small calls, and give the bulk payload
// room to actually arrive.
const FETCH_TIMEOUT_BULK_MS = 30000
function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() =>
        clearTimeout(timer),
    )
}

/* --------------------------------------------------  session bearer
 * Popup login stores the session token in storage.sync (`token`). Every
 * caramel API call attaches it as `Authorization: Bearer` so the backend
 * can tie coupon fetches and outcome reports to the account. The token is
 * read fresh per request — the MV3 service worker restarts constantly, so
 * a module-global cache would silently go stale (or start empty) after a
 * restart. Signed-out users fetch exactly as before (no header). */
function getStoredToken() {
    return new Promise(resolve => {
        try {
            // READ-ONLY twin of caramel-base.js's caramelGetSession(). The
            // session lives in storage.LOCAL so the credential does not roam
            // via Chrome Sync; sync is still read as a fallback for installs
            // that predate that move. This worker cannot load caramel-base.js
            // (service worker, no `window`), hence the deliberate duplicate —
            // but only the READ, so the migration write stays in one place:
            // the popup or a content script performs it the first time either
            // runs, which is immediately in any real session.
            currentBrowser.storage.local.get(['token'], local => {
                if (currentBrowser.runtime.lastError) {
                    resolve(null)
                    return
                }
                if (local?.token) {
                    resolve(local.token)
                    return
                }
                currentBrowser.storage.sync.get(['token'], synced => {
                    if (currentBrowser.runtime.lastError) {
                        resolve(null)
                        return
                    }
                    resolve(synced?.token || null)
                })
            })
        } catch {
            resolve(null)
        }
    })
}

async function fetchCaramelApi(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const token = await getStoredToken()
    if (!token) return fetchWithTimeout(url, opts, timeoutMs)
    return fetchWithTimeout(
        url,
        {
            ...opts,
            headers: { ...opts.headers, Authorization: `Bearer ${token}` },
        },
        timeoutMs,
    )
}

function isServiceWorkerContext() {
    return (
        typeof ServiceWorkerGlobalScope !== 'undefined' &&
        self instanceof ServiceWorkerGlobalScope
    )
}

// Detect if we're in a service worker context or traditional background script
// This is needed to support Firefox (MV2) and Chromium/Safari browsers (MV3)
const isServiceWorker = isServiceWorkerContext()

// Keep-Alive Mechanism
function keepAlive() {
    if (isServiceWorker) {
        // For service workers, use chrome.alarms to keep alive
        try {
            currentBrowser.alarms.create('keepAlive', { periodInMinutes: 1 })

            currentBrowser.alarms.onAlarm.addListener(alarm => {
                if (alarm.name === 'keepAlive') {
                    // Service worker is alive - periodic check
                }
            })
        } catch {
            // Fallback if alarms API is not available
        }
    } else {
        // For traditional background scripts, use setInterval
        setInterval(() => {
            // Background script is alive - periodic check
        }, 10000) // Check every 10 seconds
    }
}

/* --------------------------------------------------  toolbar badge
 * Shows how many coupons exist for the site in the active tab, so the
 * user knows to open Caramel before they reach checkout. Counts come
 * from the public coupons endpoint (limit=1 — only `total` is read),
 * cached per domain so tab switching doesn't refetch. Deliberately
 * anonymous (fetchWithTimeout, no bearer): it's a public aggregate that
 * fires on every tab switch, nothing user-scoped to gain. */
const BADGE_CACHE_TTL_MS = 10 * 60 * 1000
const _badgeCounts = new Map() // domain -> { count, ts }

function _setBadge(tabId, count) {
    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : ''
    try {
        currentBrowser.action.setBadgeText({ tabId, text })
    } catch {
        /* tab gone before the count arrived */
    }
}

async function _couponCountFor(domain) {
    const hit = _badgeCounts.get(domain)
    if (hit && Date.now() - hit.ts < BADGE_CACHE_TTL_MS) return hit.count
    const url = new URL(caramelUrl('api/coupons'))
    url.searchParams.set('site', domain)
    url.searchParams.set('limit', '1')
    let count = 0
    try {
        const r = await fetchWithTimeout(url.toString())
        if (r.ok) {
            const json = await r.json()
            count =
                typeof json.total === 'number'
                    ? json.total
                    : (json.coupons || []).length
        }
    } catch {
        // Offline/unreachable — treat as no badge, retry after TTL.
    }
    _badgeCounts.set(domain, { count, ts: Date.now() })
    return count
}

async function updateBadgeForTab(tabId, tabUrl) {
    if (!tabId || !tabUrl || !/^https?:/.test(tabUrl)) {
        _setBadge(tabId, 0)
        return
    }
    let domain
    try {
        domain = new URL(tabUrl).hostname.replace(/^www\./, '')
    } catch {
        _setBadge(tabId, 0)
        return
    }
    const count = await _couponCountFor(domain)
    _setBadge(tabId, count)
}

function _caramelOnTabUpdated(tabId, changeInfo, tab) {
    // Fire on navigation commit (URL change) and on load completion —
    // covers SPA address-bar updates that never re-"complete".
    if (!changeInfo.url && changeInfo.status !== 'complete') return
    updateBadgeForTab(tabId, tab.url || '')
    if (!changeInfo.url) return
    // A same-document rewrite can move the shopper into a cart without the
    // content script running again or firing anything it can hear — a store
    // that sends /cart to /?open_cart=true and then rewrites that away leaves
    // the page it already evaluated looking like an ordinary home page. This
    // listener is the only place in the extension that sees the address bar
    // change, so it tells the page.
    currentBrowser.tabs
        .sendMessage(tabId, {
            action: 'caramelUrlChanged',
            url: changeInfo.url,
        })
        // Every tab in the browser reaches here, and most have no content
        // script of ours to receive this (other origins, chrome:// pages, tabs
        // open since before the install). That rejection is the ordinary case,
        // not a failure — and it is the only one swallowed here.
        ?.catch(() => {})
}

// Everything this worker DOES, in the order the old top-level body did it. MV3
// only honours listeners registered in the worker's first turn, so the WXT
// entrypoint calls this synchronously inside main() — never behind an await.
export function initBackground() {
    currentBrowser = (() => {
        if (typeof chrome !== 'undefined') return chrome // Chrome and Chromium-based browsers
        if (typeof browser !== 'undefined') return browser // Firefox
        throw new Error('Browser is not supported!')
    })()

    keepAlive()

    try {
        currentBrowser.action.setBadgeBackgroundColor({ color: '#ea6925' })
        if (currentBrowser.action.setBadgeTextColor)
            currentBrowser.action.setBadgeTextColor({ color: '#ffffff' })
    } catch {
        /* badge styling unsupported — counts still render */
    }

    currentBrowser.tabs.onActivated.addListener(({ tabId }) => {
        currentBrowser.tabs.get(tabId, tab => {
            if (currentBrowser.runtime.lastError || !tab) return
            updateBadgeForTab(tabId, tab.url || '')
        })
    })

    currentBrowser.tabs.onUpdated.addListener(_caramelOnTabUpdated)

    currentBrowser.runtime.onMessage.addListener(
        (message, sender, sendResponse) => {
            if (!message || typeof message.action !== 'string') return
            if (message.action === 'openPopup') {
                currentBrowser.windows.create({
                    url: currentBrowser.runtime.getURL(
                        'index.html?isPopup=true&callerId=' +
                            (sender.tab?.id ?? ''),
                    ),
                    type: 'popup',
                    width: 400,
                    height: 450,
                })
                sendResponse({ success: true })
            } else if (message.action.startsWith('userLoggedInFromPopup_')) {
                const callerId = message.action.split('_')[1]
                currentBrowser.tabs.sendMessage(parseInt(callerId), {
                    action: 'userLoggedIn',
                })
                sendResponse({ success: true })
            } else if (message.action === 'keepAlive') {
                sendResponse({ status: 'alive' }) // Respond to the message
            } else if (message.action === 'classifyCart') {
                fetchCaramelApi(caramelUrl('api/classify-cart'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(message.signals || {}),
                })
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('classifyCart', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'fetchCoupons') {
                const { site, kw, category, page } = message
                const url = new URL(caramelUrl('api/coupons'))
                url.searchParams.set('site', site)
                url.searchParams.set('key_words', kw || '')
                url.searchParams.set('limit', String(COUPON_PAGE_SIZE))
                if (category) url.searchParams.set('category', category)
                // `page` is omitted entirely for page 1 so a caller that doesn't
                // paginate produces the exact URL this handler has always produced
                // (the route defaults to page=1). Bounded to the route's own cap of
                // 500 rather than forwarded raw.
                const wanted = Number(page)
                if (Number.isFinite(wanted) && wanted > 1)
                    url.searchParams.set('page', String(Math.min(wanted, 500)))
                if (CARAMEL_ENV.verbose)
                    console.log('BACKGROUND: fetchCoupons', {
                        site,
                        kw,
                        url: url.toString(),
                        t: Date.now(),
                    })
                fetchCaramelApi(url.toString())
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        const json = await r.json()
                        const coupons = Array.isArray(json)
                            ? json
                            : json.coupons || []
                        // The page envelope rides along so the popup can page
                        // through a catalog deeper than one request (eBay had 96
                        // codes while the popup only ever showed 20). A bare-array
                        // response — or any older shape without the envelope —
                        // degrades to "this is all there is", which is what every
                        // caller assumed before this existed.
                        return {
                            coupons,
                            page:
                                typeof json.page === 'number' && json.page > 0
                                    ? json.page
                                    : 1,
                            total:
                                typeof json.total === 'number'
                                    ? json.total
                                    : coupons.length,
                            hasMore: json.hasMore === true,
                        }
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err =>
                        sendResponse({ coupons: [], error: String(err) }),
                    )

                return true
            } else if (message.action === 'reportOutcome') {
                // Trust-loop signal from the apply flow (coupon-runner). Fire-and-forget:
                // errors are logged, never surfaced — a report must not break checkout.
                // A "worked" outcome also bumps the public usage counter.
                const { id, outcome, storeReason } = message
                fetchCaramelApi(caramelUrl(`api/coupons/${id}/report`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ outcome, storeReason }),
                }).catch(err => logError('reportOutcome', err))
                if (outcome === 'worked') {
                    fetchCaramelApi(caramelUrl('api/coupons/increment'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id }),
                    }).catch(err => logError('increment', err))
                }
                sendResponse({ success: true })
                return true
            } else if (message.action === 'getFavoriteStores') {
                // The stores this account follows. fetchCaramelApi so the stored
                // bearer rides along (the route is session-gated). A 401 is reported
                // as an ERROR, never an empty list: "you follow nothing" and "we
                // couldn't ask" are different answers and the star must not paint
                // the first when it means the second.
                fetchCaramelApi(caramelUrl('api/account/favorites'))
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('getFavoriteStores', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'setFavoriteStore') {
                // Follow / unfollow one store. PUT and DELETE are both idempotent
                // server-side, so a double-tap or retry is safe; the response echoes
                // the NORMALIZED key the server wrote (the popup sends a tab
                // hostname like "shop.nike.com"; the account keys on "nike.com").
                const { site, favorite } = message
                fetchCaramelApi(
                    caramelUrl(
                        `api/account/favorites/${encodeURIComponent(site)}`,
                    ),
                    { method: favorite ? 'PUT' : 'DELETE' },
                )
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('setFavoriteStore', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'syncSavings') {
                // Opt-in cloud savings sync. Routed through the worker like all
                // other API traffic so the bearer token never has to reach a
                // content script running on a store's page.
                //
                // The response is handed BACK to the caller rather than swallowed:
                // caramel-base.js marks entries synced only from what the server
                // says it stored, so a dropped response has to leave them queued.
                //
                // The error BODY is read on a failed status, not just the number:
                // the route answers 403 { error: 'savings_sync_disabled' } when the
                // account has sync off, and the sweep has to tell that permanent
                // "stop asking" apart from a transient failure it should retry.
                // Collapsing every non-ok response to `HTTP <status>` made the two
                // identical, which is an infinite retry on every popup open.
                fetchCaramelApi(caramelUrl('api/account/savings'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        events: Array.isArray(message.events)
                            ? message.events
                            : [],
                    }),
                })
                    .then(async r => {
                        if (!r.ok) {
                            const body = await r.json().catch(() => null)
                            return {
                                error: body?.error || `HTTP ${r.status}`,
                                status: r.status,
                            }
                        }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('syncSavings', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'setSavingsSync') {
                // Writes the ACCOUNT-side consent flag. The popup switch also
                // writes the device setting, but this column is the authority the
                // website reads, so a toggle that only touched local storage would
                // leave /profile showing the opposite of the popup.
                fetchCaramelApi(caramelUrl('api/account/savings-sync'), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !!message.enabled }),
                })
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('setSavingsSync', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'fetchSupportedStores') {
                const url = caramelUrl('api/extension/supported-stores')
                // The bulk payload gets the larger budget, and one retry: the
                // measured cold-connection fetch is the slow one and the warm
                // retry lands in a few seconds, so a single extra attempt is the
                // difference between a silent install and a working one.
                fetchCaramelApi(url, {}, FETCH_TIMEOUT_BULK_MS)
                    .catch(err => {
                        logError('fetchSupportedStores retry', err)
                        return fetchCaramelApi(url, {}, FETCH_TIMEOUT_BULK_MS)
                    })
                    .then(async r => {
                        if (!r.ok) return { error: `HTTP ${r.status}` }
                        return r.json()
                    })
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('fetchSupportedStores', err)
                        sendResponse({ supported: [], error: String(err) })
                    })

                return true
            } else if (message.action === 'getActiveTabDomainRecord') {
                currentBrowser.tabs.query(
                    { active: true, lastFocusedWindow: true },
                    tabs => {
                        if (!tabs || !tabs.length) {
                            sendResponse({ domainRecord: null, url: null })
                            return
                        }

                        // CONTRACT: `url` is the tab's FULL URL (scheme included),
                        // never a bare hostname. The popup's non-web-tab guard
                        // (popup.js, `/^https?:\/\//`) is the sole consumer and the
                        // scheme is the only thing that lets it tell a store page
                        // from chrome://, about:, or this extension's own pages.
                        // This handler used to answer `new URL(tabUrl).hostname` —
                        // "www.ebay.com" — which that guard nulled as a non-web
                        // tab, so the popup skipped its coupon fetch and showed
                        // the empty "Ready when you are" state on every real store
                        // (found live on eBay iOS, 2026-08-09). Pinned by
                        // tests/popup-tab-url-contract.test.mjs, which runs THIS
                        // handler against the popup's real guard.
                        sendResponse({
                            domainRecord: null,
                            url: tabs[0].url || null,
                        })
                    },
                )

                return true
            } else {
                // Unknown action — respond so the caller's promise never hangs.
                sendResponse({ error: 'unknown_action' })
            }
        },
    )
}
