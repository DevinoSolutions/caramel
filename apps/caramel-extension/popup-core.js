// Popup LOGIC core (WXT P2, 2026-08-13) — popup.js minus every render.
//
// The vanilla innerHTML views this file used to paint were rewritten as React
// components (entrypoints/popup/), and what stays here is the behavior those
// components consume: the caller relay, the OAuth wire flow, session
// validation/logout, the popup state resolution, and the pure formatters. The
// wire behaviors are PINNED (popup-oauth-*, popup-caller-relay,
// popup-auth-validate, popup-logout-revoke) — a change here is a regression,
// not a refactor.
//
// escHtml died with the renders: React escapes interpolated text natively, so
// a hand-rolled escaper would only invite double-escaping.
import {
    caramelClearSession,
    caramelGetSession,
    caramelSendMessage,
    caramelSetSession,
    caramelSetSettings,
    caramelSyncSavings,
    currentBrowser,
    log,
} from './caramel-base.js'
import { CARAMEL_ENV } from './caramel-env.js'
import { fetchCouponsPage } from './coupon-fetch.js'

// Base URL from the build-time environment stamp (caramel-env.js, the first
// module the popup realm evaluates). This used to call a shared
// `_isDevInstall()` that read the manifest's `update_url` — a field only the
// Chrome Web Store injects, so the Firefox and Safari builds of this popup
// pointed real users at the dev deployment. See the environment table in
// scripts/environments.mjs.
export const caramelUrl = path =>
    new URL(path, `${CARAMEL_ENV.baseUrl}/`).toString()

// Twin of the app's src/lib/relativeTime.ts formatWorkedAgo() — the app-owned
// "worked Xh ago" trust signal (W1). The two live across the app/extension
// runtime boundary and can't share a module, so this small formatter is a
// deliberate duplicate kept in step with its app-side twin by hand. Returns
// "worked Xh ago" / "worked Xd ago" for a recent lastWorkedAt ISO string
// (whole hours under a day, whole days otherwise), or '' when it's absent,
// unparseable, in the future, or older than 7 days (render nothing).
export const formatWorkedAgo = iso => {
    if (!iso) return ''
    const then = Date.parse(iso)
    if (Number.isNaN(then)) return ''
    const HOUR_MS = 60 * 60 * 1000
    const DAY_MS = 24 * HOUR_MS
    const diffMs = Date.now() - then
    if (diffMs < 0 || diffMs > 7 * DAY_MS) return ''
    return diffMs < DAY_MS
        ? `worked ${Math.floor(diffMs / HOUR_MS)}h ago`
        : `worked ${Math.floor(diffMs / DAY_MS)}d ago`
}

/* ------------------------------------------------------------ */
/*  Caller relay                                                */
/* ------------------------------------------------------------ */
// Set when this popup was opened as a WINDOW by the checkout modal's
// "Sign In" button (background openPopup → popup.html?callerId=<tabId>).
// Finishing login must then notify that tab so the apply flow resumes.
//
// Read off location.search at module-eval time before the ESM port; the React
// boot (entrypoints/popup/main.tsx) calls capturePopupCallerId() BEFORE the
// first render — so it is still in place before any login can complete.
// `null` until then, matching what URLSearchParams.get() returns for an
// absent parameter.
let CARAMEL_CALLER_ID = null

export function capturePopupCallerId() {
    CARAMEL_CALLER_ID = new URLSearchParams(location.search).get('callerId')
}

export function getCallerId() {
    return CARAMEL_CALLER_ID
}

// The no-caller branch of afterLoginSuccess used to call initPopup() — the
// vanilla full re-init. The React app registers its own re-resolve here at
// mount; the default is a loud no-op so a boot that forgets the registration
// shows up in tests (the caller-relay suite pins that the callback fires)
// rather than silently rendering a stale signed-out view.
let afterLoginRerender = () => {}

export function setAfterLoginRerender(fn) {
    afterLoginRerender = typeof fn === 'function' ? fn : () => {}
}

export function afterLoginSuccess() {
    if (CARAMEL_CALLER_ID) {
        try {
            const p = currentBrowser.runtime.sendMessage({
                action: 'userLoggedInFromPopup_' + CARAMEL_CALLER_ID,
            })
            if (p && typeof p.then === 'function') p.catch(() => {})
        } catch {
            /* originating tab may be gone — still close below */
        }
        // Give the message a beat to reach the service worker, then close
        // this login window; the original tab takes over.
        setTimeout(() => window.close(), 150)
        return
    }
    afterLoginRerender()
}

/* ------------------------------------------------------------ */
/*  Savings summary (pure half)                                 */
/* ------------------------------------------------------------ */
// Totals the recorded savings history per currency (a EUR cart and a USD
// cart don't sum). History comes from caramelGetSavings() (caramel-base.js)
// — written by the apply flow on measured wins only; the React SavingsBanner
// reads it and renders this total.
export function formatSavingsTotal(list) {
    const totals = new Map()
    for (const e of list || []) {
        if (!e || !(e.amount > 0)) continue
        const cur = e.currency || 'USD'
        totals.set(cur, (totals.get(cur) || 0) + e.amount)
    }
    if (!totals.size) return ''
    return Array.from(totals.entries())
        .map(([cur, amt]) => {
            try {
                return new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: cur,
                }).format(amt)
            } catch {
                return `${amt.toFixed(2)} ${cur}`
            }
        })
        .join(' + ')
}

/* ------------------------------------------------------------ */
/*  Popup state resolution                                      */
/* ------------------------------------------------------------ */
/* background helper */
async function getActiveTabDomainRecord() {
    try {
        // Bounded wait + closed-port detection (caramel-base.js); the raw
        // sendMessage form could park the popup on a never-arriving reply.
        return await caramelSendMessage({ action: 'getActiveTabDomainRecord' })
    } catch {
        return undefined // same contract as before: undefined on error
    }
}

/**
 * The decision flow that was initPopup(), returning WHAT to render instead of
 * painting it — React owns the painting (and the 400ms anti-flicker floor the
 * old DOMContentLoaded bootstrap kept). Resolves to one of:
 *   {view:'coupons', coupons, user, domain, page} — page = the full envelope
 *   {view:'unsupported', user, domain}            — domain undefined = no tab
 *   {view:'profile', user}
 *   {view:'loadError'}
 * `onSessionInvalid` is handed to validateStoredSession — the React app
 * passes its re-resolve so a dead session repaints logged-out.
 */
export async function resolvePopupState(onSessionInvalid) {
    // The service worker can reply undefined on a cold start / error; never let
    // destructuring throw and leave the user staring at a blank popup.
    let url = null
    try {
        const resp = await getActiveTabDomainRecord()
        url = resp?.url ?? null
    } catch {
        url = null
    }

    // Only web pages can have coupons. The service worker hands back whatever
    // tab is active — on a new tab, a chrome:// page, or this popup itself
    // that is a URL no store owns, and asking the coupons API about it painted
    // "Couldn't load coupons — check your connection" over what should be the
    // introduction view.
    if (url && !/^https?:\/\//i.test(url)) url = null

    const session = await caramelGetSession()
    const token = session?.token || null
    const user = session?.user || null

    // Fire the session check in PARALLEL with the coupon fetch below —
    // it must never add latency to the coupon render. A dead session
    // re-renders logged-out once the 401 lands.
    if (token) validateStoredSession(token, user, onSessionInvalid)

    // Wrap the whole resolution: a fetch failure (backend down / offline) must
    // yield an honest error state with a retry, NEVER leave the popup blank.
    try {
        if (url) {
            // url is the tab's FULL URL (background.js's
            // getActiveTabDomainRecord contract) — parse it rather than
            // regex-stripping, or the path/query would ride along into
            // the coupons API's site parameter.
            const domain = new URL(url).hostname.replace(/^www\./, '')
            // The ENVELOPE, not just the codes: a store can hold far
            // more coupons than one request returns (eBay: 96 against a
            // page of 20), and `total`/`hasMore` are what let the list
            // keep going as the shopper scrolls instead of ending
            // silently at the first page.
            let page = { coupons: [] }
            try {
                page = await fetchCouponsPage(domain, '', '', 1)
            } catch {
                return { view: 'loadError' }
            }
            const coupons = page.coupons

            if (coupons?.length) {
                return { view: 'coupons', coupons, user, domain, page }
            }
            return { view: 'unsupported', user, domain }
        }

        // no active tab info
        if (token) return { view: 'profile', user }
        return { view: 'unsupported', user: null, domain: undefined }
    } catch {
        return { view: 'loadError' }
    }
}

/* Validates the stored session token against GET /api/extension/me. The
   stored token used to be trusted forever — a revoked/expired session kept
   showing a signed-in popup. Only a REAL 401 signs the user out (storage
   cleared, then `onSessionInvalid` — the React app's re-resolve — repaints
   logged-out); network failures and 5xx keep the session — offline must
   never log the user out. A 200 refreshes the stored user {username, image}
   when the profile changed. */
export function validateStoredSession(token, storedUser, onSessionInvalid) {
    fetch(caramelUrl('api/extension/me'), {
        headers: { Authorization: `Bearer ${token}` },
    })
        .then(async res => {
            if (res.status === 401) {
                caramelClearSession(onSessionInvalid ?? (() => {}))
                return
            }
            if (!res.ok) return // backend hiccup — not a sign-out signal
            const data = await res.json().catch(() => null)
            if (!data) return
            const fresh = { username: data.username, image: data.image }
            if (
                !storedUser ||
                storedUser.username !== fresh.username ||
                storedUser.image !== fresh.image
            ) {
                // Profile only — the token is untouched, so write it beside
                // the session in local rather than back into sync.
                currentBrowser.storage.local.set({ user: fresh }, () => {})
            }

            /* Savings-sync consent, straight from the account. storage.sync
             * caches it, and is not a second source of truth: a shopper who
             * turned sync on from the website would otherwise open the popup to
             * a switch saying off, and — worse — this device would keep not
             * uploading, since the local flag gates the push. Reached only on a
             * 200, so offline leaves the cache alone rather than reading
             * silence as "off". caramelSetSettings resolves on storage errors
             * instead of rejecting, so there is no rejection path here. */
            if (typeof data.savingsSyncEnabled === 'boolean') {
                caramelSetSettings({
                    syncSavings: data.savingsSyncEnabled,
                }).then(() => {
                    // Catch-up sweep. Savings recorded while this device was
                    // offline, or whose push failed, are still queued locally
                    // and nothing else would ever retry them.
                    if (data.savingsSyncEnabled) caramelSyncSavings()
                })
            }
        })
        .catch(() => {
            /* offline/unreachable — keep the stored session */
        })
}

/* Signs the user out for REAL: revokes the session server-side, then clears
   local storage. Logout used to be storage-only, so the bearer it forgot kept
   authenticating for the rest of its 7-day life and nothing in the product
   could kill it — a token captured before logout still worked after.

   The local clear runs whether or not the revoke succeeded: someone offline
   pressing "log out" must still be logged out on this device. But the failure
   is logged rather than swallowed, because a revoke that quietly never
   happened is precisely the bug this function exists to fix.

   `button`, when given, is the control the user pressed. The revoke is a real
   network round-trip, and on a slow connection the popup sat there looking
   dead: nothing changed, so the natural response is to press "Log out" again,
   firing a second revoke of a token the first call is already killing. Say
   what's happening and stop taking further presses. The React views pass the
   real event-target element — the contract is unchanged on purpose, since the
   busy-latch behavior is pinned against exactly this shape. */
export function signOutAndRevoke(after, button) {
    if (button) {
        if (button.disabled) return // already signing out
        button.disabled = true
        button.dataset.caramelBusy = '1'
        button.textContent = 'Signing out…'
    }
    caramelGetSession().then(stored => {
        const clearLocal = () => caramelClearSession(after)
        const token = stored?.token
        if (!token) {
            clearLocal()
            return
        }
        fetch(caramelUrl('api/extension/session'), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(res => {
                if (!res.ok) log('LOGOUT_REVOKE_REJECTED', res.status)
            })
            .catch(err => log('LOGOUT_REVOKE_UNREACHABLE', err?.message))
            .finally(clearLocal)
    })
}

/* ------------------------------------------------------------ */
/*  Supported-store lookup                                      */
/* ------------------------------------------------------------ */
/* Is this domain one we actually cover?
 *
 * "We have no codes for this store right now" and "we don't cover this store"
 * are different facts, and the unsupported view used to render both as the
 * latter. A QA sweep on 2026-08-05 found huel.com — fully supported, with a
 * complete apply config — being told "No coupons for this site yet… see the
 * ones we support", with a button sending the user to a list containing the
 * very store they were standing on. Sampling 100 supported domains put
 * roughly 1 in 8 in that state, because the popup branched on coupons.length
 * alone and never consulted the supported-store list.
 *
 * The React UnsupportedView resolves this AFTER painting: a terminal state's
 * honest wording is worth a moment's wait, but not a blank popup.
 */
export function caramelDomainIsSupported(domain) {
    return new Promise(resolve => {
        if (!domain) return resolve(false)
        const host = String(domain)
            .toLowerCase()
            .replace(/^www\./, '')
        try {
            currentBrowser.runtime.sendMessage(
                { action: 'fetchSupportedStores' },
                resp => {
                    // A failed lookup must not assert either fact — fall back
                    // to the neutral copy rather than guessing.
                    if (currentBrowser.runtime.lastError || !resp || resp.error)
                        return resolve(false)
                    const list = Array.isArray(resp.supported)
                        ? resp.supported
                        : []
                    resolve(
                        list.some(entry => {
                            const d = String(entry?.domain || entry || '')
                                .toLowerCase()
                                .replace(/^www\./, '')
                            return d && (host === d || host.endsWith('.' + d))
                        }),
                    )
                },
            )
        } catch {
            resolve(false)
        }
    })
}

/* ------------------------------------------------------------ */
/*  OAuth wire flow                                             */
/* ------------------------------------------------------------ */
/* The ways an engine says "the user closed the sign-in window". Chrome sends
 * "The user did not approve access."; others word it as a cancellation. Kept
 * broad on purpose — mislabelling a real failure as a cancel is far cheaper
 * than telling someone who just clicked X that sign-in FAILED. */
const CARAMEL_OAUTH_CANCEL_RE =
    /did not approve|cancell?ed|closed by (the )?user/i

/**
 * The social sign-in wire flow, extracted from the vanilla handleSocialSignIn
 * with the DOM replaced by two callbacks — every URL, body, message string
 * and timing below is pinned (popup-oauth-* suites) and byte-identical to the
 * shipped 1.3.1 behavior:
 *   ui.onPending()    — both provider buttons disable, the clicked one reads
 *                       'Redirecting...', any prior error clears
 *   ui.onError(msg)   — the FINAL user-facing message (cancel-mapped); the
 *                       view re-enables + relabels both providers here. There
 *                       is deliberately NO success callback: success either
 *                       closes the window (caller relay) or re-renders via
 *                       afterLoginSuccess, exactly as before.
 */
export async function runSocialSignIn(provider, ui = {}) {
    ui.onPending?.()

    try {
        const baseURL = CARAMEL_ENV.baseUrl

        // Check if identity API is available
        const identity =
            currentBrowser.identity || currentBrowser.chrome?.identity
        if (!identity || !identity.launchWebAuthFlow) {
            throw new Error(
                'OAuth not supported in this browser. Please use email/password login.',
            )
        }

        // Get the extension's redirect URL
        // This will be something like: https://[extension-id].chromiumapp.org/
        const redirectUri = identity.getRedirectURL()

        // First, get the OAuth authorization URL from our backend
        // This endpoint will fetch the actual OAuth provider URL from better-auth
        const authorizeUrl = `${baseURL}/api/extension/oauth/authorize?provider=${provider}&redirect_uri=${encodeURIComponent(redirectUri)}`

        const authorizeResponse = await fetch(authorizeUrl, {
            method: 'GET',
        })

        if (!authorizeResponse.ok) {
            const errorData = await authorizeResponse.json().catch(() => ({}))
            const errorMessage =
                errorData.error ||
                `HTTP ${authorizeResponse.status}: Failed to get OAuth authorization URL`
            console.error('Authorize endpoint error:', {
                status: authorizeResponse.status,
                statusText: authorizeResponse.statusText,
                error: errorData,
            })
            throw new Error(errorMessage)
        }

        const responseData = await authorizeResponse.json().catch(() => ({}))

        if (!responseData.authorizationUrl) {
            console.error(
                'Invalid response from authorize endpoint:',
                responseData,
            )
            throw new Error(
                `Failed to get OAuth authorization URL. Response: ${JSON.stringify(responseData)}`,
            )
        }

        const { authorizationUrl } = responseData

        // Launch OAuth flow using chrome.identity with the actual OAuth provider URL
        // This opens a popup window for the user to authenticate
        // The OAuth provider will redirect to our extension's redirect URL with the code
        const finalCallbackUrl = await identity.launchWebAuthFlow({
            url: authorizationUrl,
            interactive: true,
        })

        // User closed the OAuth window without finishing → undefined callback.
        // Surface a clear "cancelled" message, not a cryptic `new URL(undefined)`.
        if (!finalCallbackUrl) throw new Error('Sign-in was cancelled.')

        // Extract code and state from the callback URL
        // Google redirects to the extension's redirect URI: https://[extension-id].chromiumapp.org/?code=...&state=...
        // chrome.identity captures this URL, and we extract the code from it
        const callbackUrlObj = new URL(finalCallbackUrl)
        const code = callbackUrlObj.searchParams.get('code')
        const receivedState = callbackUrlObj.searchParams.get('state')
        const error = callbackUrlObj.searchParams.get('error')

        if (error) {
            throw new Error(
                `OAuth error: ${error}. Please try again or use email/password login.`,
            )
        }

        if (!code) {
            // If no code, check if better-auth redirected us to a success page
            // In that case, we might need to extract the code from a different parameter
            // or make a follow-up request
            throw new Error(
                'Failed to receive authorization code. Please try again.',
            )
        }

        // Send the code to our OAuth endpoint
        // Include the redirect URI so the backend can exchange the code for tokens
        const oauthResponse = await fetch(`${baseURL}/api/extension/oauth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider,
                code,
                state: receivedState, // Send state back to the backend
                redirectUri, // Include redirect URI for token exchange
            }),
        })

        if (!oauthResponse.ok) {
            const errorData = await oauthResponse.json().catch(() => ({}))
            const errorMessage =
                errorData.error ||
                `OAuth authentication failed. Please try again.`
            throw new Error(errorMessage)
        }

        const { token, username, image } = await oauthResponse.json()
        const user = { username, image }

        // Store token and user data using Promise wrapper to ensure completion
        await new Promise((resolve, reject) => {
            caramelSetSession({ token, user }, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message))
                    return
                }
                resolve()
            })
        })

        // Small delay to ensure storage is fully persisted
        await new Promise(resolve => setTimeout(resolve, 100))

        // Checkout-modal logins notify the originating tab and close;
        // toolbar-popup logins re-render (only if still open).
        if (CARAMEL_CALLER_ID || document.visibilityState === 'visible') {
            afterLoginSuccess()
        }
    } catch (err) {
        console.error('OAuth error:', err)

        // Closing the provider window is a CANCEL, not a failure. Chrome
        // REJECTS launchWebAuthFlow in that case rather than resolving
        // undefined, so the `!finalCallbackUrl` guard above never runs here
        // and its friendly copy was dead code — what users actually saw was
        // Chrome's own third-person string, "OAuth sign-in failed: The user
        // did not approve access.", which reads like the app broke and blames
        // them for it. Recognise the cancel shapes and speak plainly. The
        // guard above stays: it covers engines that resolve undefined instead.
        ui.onError?.(
            CARAMEL_OAUTH_CANCEL_RE.test(err?.message || '')
                ? 'Sign-in was cancelled.'
                : `OAuth sign-in failed: ${err.message}`,
        )
    }
}

// Popup OAuth needs identity.launchWebAuthFlow, which Firefox deliberately
// ships without (the generated Firefox manifest has no `identity` permission
// — see the per-browser branch in wxt.config.ts). Capability check, not UA
// sniffing.
export function popupOAuthSupported() {
    const identity = currentBrowser.identity || currentBrowser.chrome?.identity
    return !!(identity && identity.launchWebAuthFlow)
}

// OAuth fallback for browsers without popup OAuth (issue #139): open the
// website's login page in a tab; once the user signs in there, the
// website→extension session relay (coupon-runner.js caramel-ext-hello ↔
// ExtensionSessionRelay.tsx) lands the session in storage.sync, so the
// popup is signed in on its next open.
export function openWebsiteSignIn() {
    currentBrowser.tabs.create({ url: caramelUrl('login') })
    window.close()
}

/* ------------------------------------------------------------ */
/*  Coupon list constants (data half — the views render them)   */
/* ------------------------------------------------------------ */
/* Identity of a coupon ACROSS requests, for the append dedupe.
 *
 * Offset paging over a live catalog is not a snapshot: an ingest between page 1
 * and page 2 can shift a row across the boundary and hand it to us twice. The
 * catalog id is the real identity; a code is the fallback for the rare row that
 * arrives without one, and is unique per store in practice. */
export function couponIdentity(c) {
    return c?.id != null ? `id:${c.id}` : `code:${c?.code}`
}

/* How many consecutive all-duplicate pages to chase before handing the shopper
 * a button instead. Small on purpose: the point is to get past one shifted
 * page, not to walk a catalog the backend keeps re-serving. */
export const COUPON_PAGE_EMPTY_LIMIT = 3

/* Guests see a teaser, not the catalog. OWNER RULE (2026-08-10): "for guests
 * dont show all coupons" — the full list, and the infinite scroll that walks
 * it, are signed-in features. Six rows is about two screens of the 320px
 * list: enough to prove the codes are real, small enough that signing in
 * visibly buys something. The gate only exists when it hides something — a
 * guest on a store with this many codes or fewer sees exactly what a member
 * sees. */
export const GUEST_COUPON_LIMIT = 6
