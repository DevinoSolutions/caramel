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
import { buildFunnelEvent } from './code-share-funnel.js'
import {
    codeSharingAccepted,
    codeSharingPromptVersion,
    readCodeSharingConsent,
} from './code-sharing-consent.js'
import { saveInstallId } from './install-attribution.js'
import { caramelTabHandoffs } from './tab-handoff.js'
import {
    USAGE_DIAGNOSTICS_CONSENT_KEY,
    deleteTelemetryId,
    parseUsageDiagnosticsConsent,
    readTelemetryId,
    readUsageDiagnosticsConsent,
    resolveUsageDiagnostics,
    usageDiagnosticsAccepted,
} from './usage-diagnostics-consent.js'

/* What a content script leaves for the next document of its tab (the
 * pending submit, the discount-link win, the run across reloads), held here
 * where the store's page cannot write it (tab-handoff.js). The tab and the
 * origin are the message sender's, never the message's, and only the tab's
 * top document, while it is the live one, may hand anything off (a frame is
 * another site's document, a prerendered or cached one is not the page the
 * shopper is on). Answers { saved }, { value } for get/take, { cleared }, or
 * { error }. */
let _tabHandoffs = null
const tabHandoffs = () =>
    (_tabHandoffs ??= caramelTabHandoffs(
        currentBrowser.storage?.session ?? null,
    ))
function senderOrigin(sender) {
    try {
        const origin = new URL(sender?.url || sender?.tab?.url).origin
        return origin === 'null' ? null : origin
    } catch {
        return null
    }
}
async function tabHandoff({ op, key, value, expected }, sender) {
    const tabId = sender?.tab?.id
    const origin = senderOrigin(sender)
    if (!Number.isInteger(tabId) || !origin) return { error: 'no tab' }
    if (sender.frameId !== 0) return { error: 'not the top document' }
    // documentLifecycle is Chrome's; a browser without it is not asked.
    if (
        sender.documentLifecycle !== undefined &&
        sender.documentLifecycle !== 'active'
    )
        return { error: 'not the live document' }
    const h = tabHandoffs()
    const refused = saved => {
        if (saved === 'refused') logError('tabHandoffRefused', `${op} ${key}`)
        return { saved }
    }
    if (op === 'set') return refused(await h.set(tabId, origin, key, value))
    if (op === 'replace')
        return refused(await h.replace(tabId, origin, key, value, expected))
    if (op === 'get') return { value: await h.get(tabId, origin, key) }
    if (op === 'take') return { value: await h.take(tabId, origin, key) }
    if (op === 'clear') {
        await h.clear(tabId, origin, key)
        return { cleared: true }
    }
    return { error: 'unknown op' }
}

// Assigned by initBackground() instead of at module evaluation: the IIFE throws
// when neither global exists, which is exactly the case in the Node import
// above. Every reader below sits in a function body that runs after init, so
// the value each one sees is unchanged.
let currentBrowser

const caramelUrl = path => new URL(path, `${CARAMEL_BASE_URL}/`).toString()

// Which store channel this build is running from, for install attribution.
// The runtime URL scheme separates Firefox and Safari; Edge installs the same
// Chromium build as Chrome, so only its user agent tells them apart. The four
// values mirror EXTENSION_STORES in apps/caramel-app/src/lib/extensionInstall.ts
// (pinned by tests/install-welcome.test.mjs).
export const detectStoreChannel = (runtimeUrl, userAgent) => {
    if (runtimeUrl.startsWith('moz-extension://')) return 'firefox'
    if (runtimeUrl.startsWith('safari-web-extension://')) return 'safari'
    return /\bEdg(e|A|iOS)?\//.test(userAgent) ? 'edge' : 'chrome'
}

// The one-time post-install page (apps/caramel-app/src/app/welcome). `iid` is
// minted per install and becomes the PostHog event uuid there, so reloading or
// re-opening the page can never count the install twice.
export const welcomeUrl = (store, version, iid) =>
    caramelUrl(
        'welcome?' +
            new URLSearchParams({ src: 'ext', store, v: version, iid }),
    )

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
    return fetchWithTimeout(
        url,
        withBearer(opts, await getStoredToken()),
        timeoutMs,
    )
}

// `opts` with the session bearer attached, or unchanged when signed out.
function withBearer(opts, token) {
    if (!token) return opts
    return {
        ...opts,
        headers: { ...opts.headers, Authorization: `Bearer ${token}` },
    }
}

/* --------------------------------------------------  shopper code sharing
 * code-capture.js (content script) hands us a code the shopper typed and the
 * store accepted. Whether it may leave the browser is decided HERE, not in the
 * page: signed in, the server flag on, and the shopper's explicit consent
 * (checkoutCodeSharingConsent === accepted, see code-sharing-consent.js; absent,
 * declined or malformed all refuse). The gates run in that order, so
 * `no-consent` is only ever answered to a signed-in shopper while the flag is
 * on: that answer is the content script's cue to show the consent prompt, which
 * is therefore never shown when sharing could not happen anyway. The flag is read from the public
 * features endpoint and cached (storage.session when the browser has it, so a
 * restarted worker does not refetch; memory otherwise): 6h for `true`, but only
 * 30min for `false`, so an owner flipping the flag on is felt within half an
 * hour. Concurrent callers share one in-flight fetch.
 *
 * Outcomes are returned to the content script as `{ skipped }` for every
 * expected refusal (signed out, flag off, store/code refused, rate limits) and
 * as a THROW (logged by the caller, answered as `{ error }`) for anything that
 * is a real failure: 5xx, network, an unreadable body, the extension-only
 * origin guard. */
const FEATURES_CACHE_KEY = 'caramel_features'
const FEATURES_TTL_ON_MS = 6 * 60 * 60 * 1000
const FEATURES_TTL_OFF_MS = 30 * 60 * 1000
let _featuresInflight = null // Promise<entry> while a fetch is running
let _featuresMemo = null // { shopperCodeCapture, couponBoxDiscovery, couponBoxLlm, ts }

function _readFeaturesSession() {
    return new Promise(resolve => {
        const area = currentBrowser.storage?.session
        if (!area) return resolve(null)
        try {
            area.get([FEATURES_CACHE_KEY], res =>
                resolve(res?.[FEATURES_CACHE_KEY] ?? null),
            )
        } catch {
            // session storage unavailable in this runtime: memory-only cache.
            resolve(null)
        }
    })
}

function _writeFeaturesSession(entry) {
    try {
        currentBrowser.storage?.session?.set({ [FEATURES_CACHE_KEY]: entry })
    } catch {
        // session storage unavailable in this runtime: memory-only cache.
    }
}

function _featuresFresh(e) {
    if (!e || typeof e.shopperCodeCapture !== 'boolean') return false
    // While the promo-box finder or its server pick is on, the short lifetime:
    // turning either OFF is the kill switch, and it must reach extensions
    // within 30 minutes.
    const ttl =
        e.shopperCodeCapture &&
        e.couponBoxDiscovery !== true &&
        e.couponBoxLlm !== true
            ? FEATURES_TTL_ON_MS
            : FEATURES_TTL_OFF_MS
    return Date.now() - e.ts < ttl
}

async function _fetchFeatures() {
    // Public, anonymous: no bearer (nothing user-scoped in the answer).
    const r = await fetchWithTimeout(caramelUrl('api/extension/features'))
    if (!r.ok) throw new Error(`features HTTP ${r.status}`)
    const json = await r.json()
    if (typeof json?.shopperCodeCapture !== 'boolean')
        throw new Error('features: shopperCodeCapture is not a boolean')
    _featuresMemo = {
        shopperCodeCapture: json.shopperCodeCapture,
        // Anything but a literal true is off: an app that predates the flag
        // omits it, and the finder must never switch itself on.
        couponBoxDiscovery: json.couponBoxDiscovery === true,
        // The same rule for the server pick (POST coupon-box-pick).
        couponBoxLlm: json.couponBoxLlm === true,
        ts: Date.now(),
    }
    _writeFeaturesSession(_featuresMemo)
    return _featuresMemo
}

/* The cached features entry. Lifetime (see _featuresFresh): 6 hours only while
 * capture is on and the finder is off, 30 minutes otherwise, so switching the
 * finder off reaches every extension within 30 minutes. */
function _features() {
    if (_featuresFresh(_featuresMemo)) return Promise.resolve(_featuresMemo)
    // One fetch for however many callers arrive while it is running; cleared
    // when it settles so a failure is retried by the next caller.
    if (!_featuresInflight) {
        _featuresInflight = (async () => {
            const stored = await _readFeaturesSession()
            if (_featuresFresh(stored)) {
                _featuresMemo = stored
                return stored
            }
            return _fetchFeatures()
        })().finally(() => {
            _featuresInflight = null
        })
    }
    return _featuresInflight
}

function _shopperCaptureEnabled() {
    return _features().then(e => e.shopperCodeCapture)
}

// Answers the content script's couponBoxDiscoveryEnabled message. Any failure
// to read the flag is answered as off: the finder is an addition, never a
// requirement.
async function couponBoxDiscoveryEnabled() {
    try {
        return (await _features()).couponBoxDiscovery === true
    } catch (err) {
        logError('features', err)
        return false
    }
}

// Answers the content script's couponBoxLlmEnabled message, the same way.
async function couponBoxLlmEnabled() {
    try {
        return (await _features()).couponBoxLlm === true
    } catch (err) {
        logError('features', err)
        return false
    }
}

/* Asks the server which element of a page outline is the promo box (see
 * coupon-box-outline.js and the finder's caramelPickedRecord). The outline is
 * forwarded as built; the answer is passed back as the server sent it, and a
 * refusal (429 over budget, 413 too large) as { error }. The flag is read
 * again here, so a content script on a stale answer cannot spend a call.
 *
 * ONE deadline covers the whole ask: the flag read (which may refetch the
 * features, up to FETCH_TIMEOUT_MS), the token read and the request. The
 * request gets what is left of it, never more than its own cap, and is not
 * sent at all with less than COUPON_BOX_PICK_MIN_MS left: a paid answer the
 * page has stopped waiting for is money for nothing.
 *
 * Three numbers, each above the one before: the server gives the model 20s
 * and then answers no_pick itself (measured p95 16-18s); this side allows the
 * whole ask 24s, so the request can outwait the server's own limit; the page
 * waits PICK_WAIT_MS, 29s (coupon-box-discovery.js), so an answer sent inside
 * this deadline always reaches it. Raise one, raise the ones after it. */
export const COUPON_BOX_PICK_DEADLINE_MS = 24000
const COUPON_BOX_PICK_TIMEOUT_MS = 23000
const COUPON_BOX_PICK_MIN_MS = 3000
async function couponBoxPick({ domain, outline }) {
    const deadline = Date.now() + COUPON_BOX_PICK_DEADLINE_MS
    if (!(await couponBoxLlmEnabled())) return { error: 'disabled' }
    const token = await getStoredToken()
    const left = Math.min(COUPON_BOX_PICK_TIMEOUT_MS, deadline - Date.now())
    if (left < COUPON_BOX_PICK_MIN_MS) return { error: 'out of time' }
    const r = await fetchWithTimeout(
        caramelUrl('api/extension/coupon-box-pick'),
        withBearer(
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain, outline }),
            },
            token,
        ),
        left,
    )
    if (!r.ok) return { error: `HTTP ${r.status}` }
    return r.json()
}

function _forgetFeatures() {
    _featuresMemo = null
    try {
        currentBrowser.storage?.session?.remove?.([FEATURES_CACHE_KEY])
    } catch {
        // session storage unavailable in this runtime: memory-only cache.
    }
}

// Exported for tests/background-shopper-code.test.mjs.
export async function submitShopperCode(message) {
    const { site, code } = message
    if (typeof site !== 'string' || typeof code !== 'string')
        throw new Error('submitShopperCode: site and code must be strings')
    if (!(await getStoredToken())) return { skipped: 'signed-out' }
    if (!(await _shopperCaptureEnabled())) return { skipped: 'disabled' }
    // A failed storage read rejects (loud, answered as `{ error }`): refusing
    // to send is the safe side, and it must not look like a plain "no".
    // The SAME record gates the send and is the proof sent with it: the server
    // refuses a checkout submission without an accepted consent (403
    // `consent-required`), so a build that omits the field can never capture.
    const consentRecord = await readCodeSharingConsent(currentBrowser)
    if (!codeSharingAccepted(consentRecord)) return { skipped: 'no-consent' }

    const r = await fetchCaramelApi(caramelUrl('api/coupons/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            site,
            code,
            source: 'checkout',
            consent: {
                choice: consentRecord.choice,
                promptVersion: consentRecord.promptVersion,
                at: consentRecord.at,
            },
        }),
    })
    // On a refusal the body is only used to NAME it; one we cannot read just
    // falls back to the generic reason below.
    const body = r.ok ? await r.json() : await r.json().catch(() => null)

    if (r.ok) {
        if (typeof body?.couponId !== 'string')
            throw new Error('submit: response has no couponId')
        return {
            couponId: body.couponId,
            created: body.created === true,
            status: body.status,
        }
    }
    if (r.status === 401) return { skipped: 'signed-out' }
    if (r.status === 403 && body?.error === 'capture-disabled') {
        // The server disagrees with our cached flag: refresh it next time.
        _forgetFeatures()
        return { skipped: 'disabled' }
    }
    // The server's own consent gate refused the proof we just sent (e.g. its
    // prompt-version floor moved above ours). Quiet, nothing was stored. NOT
    // `no-consent`: that answer is the page's cue to show the consent card
    // (code-capture.js _submitWithConsent), and a shopper who already said yes
    // must not be asked again because the server disagrees with the record.
    if (r.status === 403 && body?.error === 'consent-required')
        return { skipped: 'consent-rejected' }
    if (r.status === 422) {
        // Expected refusals (not a store we know, not a plausible code).
        if (CARAMEL_ENV.verbose)
            console.debug('Caramel: shopper code refused', body?.error)
        return { skipped: body?.error || 'refused' }
    }
    if (r.status === 429)
        return {
            skipped:
                body?.error === 'daily-limit' ? 'daily-limit' : 'rate-limited',
        }
    // 5xx, and the extension-only origin guard (a 403 we should never see from
    // our own worker): real failures, loud.
    throw new Error(
        `submit HTTP ${r.status}${body?.error ? ` ${body.error}` : ''}`,
    )
}

/* --------------------------------------------------  code-share funnel diagnostics
 * code-capture.js reports each point where the code-sharing offer can stop
 * (code-share-funnel.js has the steps). Whether anything may leave the browser
 * is decided HERE: the shopper's usageDiagnosticsConsent must be accepted and,
 * on Firefox, the browser's data-collection grant must be held
 * (usage-diagnostics-consent.js). Otherwise the answer is `{ skipped }` and no
 * request is made. The request is ANONYMOUS on purpose: no bearer, no cookies,
 * the per-device telemetry id as the only identity (READ here, never minted: the
 * accept path owns minting, so a missing id means skip), the consent record as the
 * proof the server checks (403 consent-required), and a payload that only
 * buildFunnelEvent's allowlist can produce — never a code, user, URL or cart.
 *
 * A malformed step, a failed storage/permission read, a non-2xx or an event the
 * server did not capture THROWS (the handler logs it and answers `{ error }`);
 * there is no retry queue: a lost diagnostic is acceptable, a silent one is not. */
// Exported for tests/background-code-share-funnel.test.mjs.
export async function reportCodeShareFunnel(message) {
    const consent = await resolveUsageDiagnostics(currentBrowser)
    if (!consent) return { skipped: 'no-diagnostics-consent' }
    const event = buildFunnelEvent({
        step: message.step,
        reason: message.reason,
        store: message.store,
        extVersion: currentBrowser.runtime.getManifest().version,
        browser: detectStoreChannel(
            currentBrowser.runtime.getURL(''),
            navigator.userAgent,
        ),
        sharingPromptVersion: codeSharingPromptVersion(),
    })
    const id = await readTelemetryId(currentBrowser)
    if (!id) return { skipped: 'no-diagnostics-id' }
    // The shopper may have withdrawn while the id was being read: the record is
    // the gate, so look at it once more right before anything leaves.
    const latest = await readUsageDiagnosticsConsent(currentBrowser)
    if (!usageDiagnosticsAccepted(latest))
        return { skipped: 'no-diagnostics-consent' }
    const r = await fetchWithTimeout(caramelUrl('api/extension/telemetry'), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id,
            event,
            consent: {
                choice: latest.choice,
                promptVersion: latest.promptVersion,
            },
        }),
    })
    const body = await r.json().catch(() => null)
    // The server's own consent floor moved above our record's version: quiet,
    // nothing was emitted (same reading as the submit route's consent gate).
    if (r.status === 403 && body?.error === 'consent-required')
        return { skipped: 'consent-rejected' }
    if (!r.ok)
        throw new Error(
            `telemetry HTTP ${r.status}${body?.error ? ` ${body.error}` : ''}`,
        )
    if (body?.captured !== true)
        throw new Error('telemetry: the server did not capture the event')
    return { sent: true }
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
// One request per domain at a time: a navigation reports both the URL change
// and the load completing, and both used to fetch before either was cached.
const _badgeInFlight = new Map() // domain -> Promise<number>
// The count shares the per-IP burst budget (20 requests / 2s) with the coupon
// list a shopper opens at checkout. After a 429 the badge waits as long as the
// server asked, so it is never the reason that list is refused.
let _badgePausedUntil = 0

function _setBadge(tabId, count) {
    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : ''
    try {
        currentBrowser.action.setBadgeText({ tabId, text })
    } catch {
        /* tab gone before the count arrived */
    }
}

function _couponCountFor(domain) {
    const hit = _badgeCounts.get(domain)
    if (hit && Date.now() - hit.ts < BADGE_CACHE_TTL_MS)
        return Promise.resolve(hit.count)
    if (Date.now() < _badgePausedUntil) return Promise.resolve(hit?.count ?? 0)
    let p = _badgeInFlight.get(domain)
    if (!p) {
        p = _fetchCouponCount(domain).finally(() =>
            _badgeInFlight.delete(domain),
        )
        _badgeInFlight.set(domain, p)
    }
    return p
}

async function _fetchCouponCount(domain) {
    const url = new URL(caramelUrl('api/coupons'))
    url.searchParams.set('site', domain)
    url.searchParams.set('limit', '1')
    let count = 0
    try {
        const r = await fetchWithTimeout(url.toString())
        if (r.status === 429) {
            const after = Number(r.headers?.get?.('retry-after'))
            _badgePausedUntil =
                Date.now() + (after > 0 ? Math.min(after, 600) : 60) * 1000
            // Not cached: the count is unknown, not zero.
            return _badgeCounts.get(domain)?.count ?? 0
        }
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

// Exported for tests/badge.test.mjs, which drives the badge directly.
export async function updateBadgeForTab(tabId, tabUrl) {
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

// Exported for tests/badge.test.mjs.
export function _caramelOnTabActivated({ tabId }) {
    try {
        currentBrowser.tabs.get(tabId, tab => {
            if (currentBrowser.runtime.lastError || !tab) return
            updateBadgeForTab(tabId, tab.url || '')
        })
    } catch (err) {
        logError('badgeOnActivated', err)
    }
}

// Exported for tests/badge.test.mjs.
export function _caramelOnTabUpdated(tabId, changeInfo, tab) {
    // Fire on navigation commit (URL change) and on load completion —
    // covers SPA address-bar updates that never re-"complete".
    if (!changeInfo.url && changeInfo.status !== 'complete') return
    // A tab loading out of sight (restored at startup, opened in the
    // background) is counted when the shopper switches to it, so restoring
    // twenty tabs does not ask for twenty counts at once.
    if (tab.active !== false) updateBadgeForTab(tabId, tab.url || '')
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

    // Withdrawing diagnostics consent (the popup toggle or "No thanks") deletes
    // the telemetry id: sends stop at once because the gate reads the record, and
    // a later opt-in starts a new id that cannot be joined to this one. The
    // record is device-local, so only this device's own changes arrive here.
    currentBrowser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[USAGE_DIAGNOSTICS_CONSENT_KEY]) return
        const next = parseUsageDiagnosticsConsent(
            changes[USAGE_DIAGNOSTICS_CONSENT_KEY].newValue,
        )
        if (usageDiagnosticsAccepted(next)) return
        deleteTelemetryId(currentBrowser).catch(err =>
            logError('usageDiagnosticsWithdraw', err),
        )
    })

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
    currentBrowser.tabs.onActivated?.addListener(_caramelOnTabActivated)

    // A closed tab's handoffs (tab-handoff.js) are never read again.
    currentBrowser.tabs.onRemoved?.addListener(tabId =>
        tabHandoffs()
            .forgetTab(tabId)
            .catch(err => logError('tabHandoffForget', err)),
    )
    // A tab swapped for a prerendered one gets a new id. Its records are not
    // moved to it: a run, a pending code or a win is let go rather than
    // carried into a document that did not ask for it.
    currentBrowser.tabs.onReplaced?.addListener((_added, removedTabId) =>
        tabHandoffs()
            .forgetTab(removedTabId)
            .catch(err => logError('tabHandoffForget', err)),
    )

    // The user granted us host access (permission-state.js requestAllSites, or
    // the browser's own permissions UI). The popup does not need telling — it
    // re-derives permission state on every open — so this records the fact and
    // nothing else. It exists because Firefox's permission doorhanger can tear
    // the popup down while the prompt is open, which kills the continuation
    // that would otherwise have been the only trace that the grant landed.
    // Guarded: `permissions` is absent in some runtimes, and a missing
    // listener must not take the worker's registration turn down with it.
    if (currentBrowser.permissions?.onAdded?.addListener) {
        currentBrowser.permissions.onAdded.addListener(permissions => {
            const origins = permissions?.origins ?? []
            if (CARAMEL_ENV.verbose)
                console.log('Caramel: permissions granted', origins)
            try {
                currentBrowser.storage.local.set({
                    caramel_all_sites_granted_at: Date.now(),
                })
            } catch (err) {
                logError('permissionsOnAdded', err)
            }
        })
    }

    // First install only: an update (reason 'update'), a browser update and a
    // shared-module update all pass through here too and must open nothing.
    currentBrowser.runtime.onInstalled.addListener(details => {
        if (details?.reason !== 'install') return
        try {
            const iid = crypto.randomUUID()
            // Keep the install id: the sign-in sends it to the server so the
            // account joins this install's `extension_installed` event, and the
            // /welcome page (content script) adds the first-touch record next
            // to it. Not awaited: the tab does not depend on it, and storage
            // answers long before a page has loaded. A refusal is recorded.
            saveInstallId(currentBrowser, iid).catch(err =>
                logError('onInstalledSaveInstallId', err),
            )
            const url = welcomeUrl(
                detectStoreChannel(
                    currentBrowser.runtime.getURL(''),
                    navigator.userAgent,
                ),
                currentBrowser.runtime.getManifest().version,
                iid,
            )
            currentBrowser.tabs.create({ url }, () => {
                if (currentBrowser.runtime.lastError)
                    logError(
                        'onInstalledWelcome',
                        currentBrowser.runtime.lastError,
                    )
            })
        } catch (err) {
            logError('onInstalledWelcome', err)
        }
    })

    currentBrowser.runtime.onMessage.addListener(
        (message, sender, sendResponse) => {
            if (!message || typeof message.action !== 'string') return
            if (message.action === 'openPopup') {
                currentBrowser.windows.create({
                    // popup.html since the WXT P1 port (was index.html) —
                    // WXT names the page after its entrypoint directory.
                    // popup-core.js parses callerId back out of this URL; the
                    // mint→parse round-trip is pinned in
                    // tests/background-caller-relay.test.mjs.
                    url: currentBrowser.runtime.getURL(
                        'popup.html?isPopup=true&callerId=' +
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
                const { site, kw, category, page, capabilities } = message
                const url = new URL(caramelUrl('api/coupons'))
                url.searchParams.set('site', site)
                // Proof of the page-side helpers this page runs (see
                // extension-capabilities.js): the server withholds a gated
                // store's codes without it. Absent when none is held.
                if (Array.isArray(capabilities) && capabilities.length)
                    url.searchParams.set(
                        'caps',
                        capabilities
                            .filter(c => typeof c === 'string')
                            .join(','),
                    )
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
                const { id, outcome, storeReason, awaitResult } = message
                const report = fetchCaramelApi(
                    caramelUrl(`api/coupons/${id}/report`),
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ outcome, storeReason }),
                    },
                )
                if (awaitResult) {
                    // The popup's "Did it work?" vote: the shopper is waiting on
                    // the answer, so the real status goes back (a 429 reads
                    // differently from a dead network) instead of a swallowed
                    // failure. No usage bump — a vote is not an apply.
                    report
                        .then(r =>
                            sendResponse(
                                r.ok
                                    ? { success: true }
                                    : {
                                          error: `HTTP ${r.status}`,
                                          status: r.status,
                                      },
                            ),
                        )
                        .catch(err => {
                            logError('reportOutcome', err)
                            sendResponse({ error: String(err) })
                        })
                    return true
                }
                report.catch(err => logError('reportOutcome', err))
                if (outcome === 'worked') {
                    fetchCaramelApi(caramelUrl('api/coupons/increment'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id }),
                    }).catch(err => logError('increment', err))
                }
                sendResponse({ success: true })
                return true
            } else if (message.action === 'submitShopperCode') {
                submitShopperCode(message)
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('submitShopperCode', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'reportCodeShareFunnel') {
                reportCodeShareFunnel(message)
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('reportCodeShareFunnel', err)
                        sendResponse({ error: String(err) })
                    })

                return true
            } else if (message.action === 'couponBoxDiscoveryEnabled') {
                couponBoxDiscoveryEnabled().then(enabled =>
                    sendResponse({ enabled }),
                )
                return true
            } else if (message.action === 'couponBoxLlmEnabled') {
                couponBoxLlmEnabled().then(enabled => sendResponse({ enabled }))
                return true
            } else if (message.action === 'couponBoxPick') {
                couponBoxPick(message)
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('couponBoxPick', err)
                        sendResponse({ error: String(err) })
                    })
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
            } else if (message.action === 'tabHandoff') {
                tabHandoff(message, sender)
                    .then(resp => sendResponse(resp))
                    .catch(err => {
                        logError('tabHandoff', err)
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
                        // (popup-core.js, `/^https?:\/\//`) is the sole consumer and the
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
