// ES module since the WXT P1 port (2026-08-12) — the popup realm's last
// script becomes its last module, so the `/* global currentBrowser,
// fetchCouponsPage */` header that stood here is replaced by real imports.
// This file had exactly two effectful top-level statements (the ?callerId=
// read and the DOMContentLoaded registration); both moved, in their original
// order, into the exported initPopupEntry() below. Everything else was
// already a pure declaration and stays at module scope.
import {
    caramelClearSession,
    caramelGetSavings,
    caramelGetSession,
    caramelGetSettings,
    caramelSendMessage,
    caramelSetSession,
    caramelSetSettings,
    caramelSyncSavings,
    currentBrowser,
    log,
} from './caramel-base.js'
import { CARAMEL_ENV } from './caramel-env.js'
import { CaramelCoupons } from './coupon-constants.generated.js'
import { fetchCouponsPage } from './coupon-fetch.js'
import { caramelCopyText } from './UI-helpers.js'

// Base URL from the build-time environment stamp (caramel-env.js, the first
// module the popup realm evaluates). This used to call a shared
// `_isDevInstall()` that read the manifest's `update_url` — a field only the
// Chrome Web Store injects, so the Firefox and Safari builds of this popup
// pointed real users at the dev deployment. See the environment table in
// scripts/environments.mjs.
const caramelUrl = path => new URL(path, `${CARAMEL_ENV.baseUrl}/`).toString()

// Escape coupon/API data before interpolating into innerHTML. Codes, titles and
// messages come from the API; without this a code containing a quote/angle
// bracket would break its `data-code` attribute (corrupting the copied value)
// or leak stray markup into the layout.
const escHtml = s =>
    String(s == null ? '' : s).replace(
        /[&<>"']/g,
        ch =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[ch],
    )

// Twin of the app's src/lib/relativeTime.ts formatWorkedAgo() — the app-owned
// "worked Xh ago" trust signal (W1). The two live across the app/extension
// runtime boundary and can't share a module, so this small formatter is a
// deliberate duplicate kept in step with its app-side twin by hand. Returns
// "worked Xh ago" / "worked Xd ago" for a recent lastWorkedAt ISO string
// (whole hours under a day, whole days otherwise), or '' when it's absent,
// unparseable, in the future, or older than 7 days (render nothing).
const formatWorkedAgo = iso => {
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
/*  Globals                                                     */
/* ------------------------------------------------------------ */
let returnView = null // callback for the “Back” button, set dynamically

// Set when this popup was opened as a WINDOW by the checkout modal's
// "Sign In" button (background openPopup → popup.html?callerId=<tabId>).
// Finishing login must then notify that tab so the apply flow resumes.
//
// Read off location.search at module-eval time before the ESM port; now
// captured as the FIRST statement of initPopupEntry(), which the popup
// entrypoint calls before anything can render — so it is still in place
// before any login can complete. `null` until then, matching what
// URLSearchParams.get() returns for an absent parameter.
let CARAMEL_CALLER_ID = null

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
    initPopup()
}

/* ------------------------------------------------------------ */
/*  Savings summary                                             */
/* ------------------------------------------------------------ */
// Totals the recorded savings history per currency (a EUR cart and a USD
// cart don't sum) and renders "You've saved …" into #savingsSummary when
// there's anything to show. History comes from caramelGetSavings()
// (caramel-base.js) — written by the apply flow on measured wins only.
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

async function renderSavingsSummary() {
    const slot = document.getElementById('savingsSummary')
    if (!slot) return
    const list = await caramelGetSavings()
    const total = formatSavingsTotal(list)
    if (!total) return
    slot.innerHTML = `
      <div class="savings-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2v20"/>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
        </svg>
        <span>You've saved <b>${escHtml(total)}</b> with Caramel</span>
      </div>`
}

/* ------------------------------------------------------------ */
/*  Settings view                                               */
/* ------------------------------------------------------------ */
// In-popup extension preferences: the global checkout-prompt toggle and a
// pause-this-site toggle (when a site is known). Persisted via
// caramelSetSettings() (storage.sync — roams with the browser profile);
// the checkout pill honors them in insertCaramelPrompt().
export async function renderSettingsView(backFn, domain) {
    const container = document.getElementById('auth-container')
    if (!container) return
    const s = await caramelGetSettings()
    // Savings sync needs an account to sync TO, so the row is signed-in only —
    // the gate #accountLink already uses. A guest tapping a switch that can only
    // bounce them into sign-in is a dead end.
    const session = await caramelGetSession().catch(() => null)
    const hasAccount = !!session?.token
    // Dot-less "domains" are extension pages (the popup opened as a tab /
    // login window reports its own chrome-extension host) — no site toggle.
    const site =
        domain && domain.includes('.')
            ? domain.toLowerCase().replace(/^www\./, '')
            : null
    const sitePaused = site
        ? s.disabledSites.some(d => site === d || site.endsWith('.' + d))
        : false

    container.innerHTML = `
    <div class="settings-view fade-in-up">
      <h3 class="settings-title">Settings</h3>

      <label class="settings-row">
        <span class="settings-copy">
          <span>Checkout prompt</span>
          <small>Offer to auto-apply the best code at checkout</small>
        </span>
        <input type="checkbox" id="autoApplyToggle" class="settings-switch" ${s.autoApply ? 'checked' : ''}/>
      </label>

      ${
          site
              ? `<label class="settings-row">
        <span class="settings-copy">
          <span>Pause on ${escHtml(site)}</span>
          <small>Don't show the prompt on this site</small>
        </span>
        <input type="checkbox" id="siteToggle" class="settings-switch" ${sitePaused ? 'checked' : ''}/>
      </label>`
              : ''
      }

      ${
          hasAccount
              ? `<label class="settings-row">
        <span class="settings-copy">
          <span>Sync my savings</span>
          <small>Keep your savings on your Caramel account, not just this device</small>
        </span>
        <input type="checkbox" id="syncSavingsToggle" class="settings-switch" role="switch" ${s.syncSavings ? 'checked' : ''}/>
      </label>
      <span id="syncSavingsStatus" role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;"></span>`
              : ''
      }

      <div id="savingsSummary"></div>

      <a id="accountLink" class="account-link" href="${caramelUrl('profile#savings')}" target="_blank" rel="noopener noreferrer" style="display:none;">Manage account →</a>

      <button id="backBtn" class="back-btn" type="button">← Back</button>
    </div>`

    renderSavingsSummary()

    const autoApplyToggle = document.getElementById('autoApplyToggle')
    if (autoApplyToggle)
        autoApplyToggle.addEventListener('change', e => {
            caramelSetSettings({ autoApply: e.target.checked })
        })

    const siteToggle = document.getElementById('siteToggle')
    if (siteToggle && site)
        siteToggle.addEventListener('change', async e => {
            const cur = await caramelGetSettings()
            const rest = cur.disabledSites.filter(d => d !== site)
            caramelSetSettings({
                disabledSites: e.target.checked ? [...rest, site] : rest,
            })
        })

    /* Savings sync. The ACCOUNT column is the authority, so: server first,
     * device cache second — writing the local flag up front and reconciling
     * later would leave a device claiming consent the account never recorded,
     * and that flag is what gates every upload. On failure the switch goes back
     * where it was: this one governs whether a shopping record leaves the
     * device, so it must never overstate what happened. */
    const syncSavingsToggle = document.getElementById('syncSavingsToggle')
    if (syncSavingsToggle)
        syncSavingsToggle.addEventListener('change', async e => {
            const requested = e.target.checked
            const status = document.getElementById('syncSavingsStatus')
            syncSavingsToggle.disabled = true
            let resp = null
            try {
                resp = await caramelSendMessage({
                    action: 'setSavingsSync',
                    enabled: requested,
                })
            } catch (err) {
                resp = { error: String(err) }
            }
            syncSavingsToggle.disabled = false

            if (
                !resp ||
                resp.error ||
                typeof resp.savingsSyncEnabled !== 'boolean'
            ) {
                e.target.checked = !requested
                const message =
                    'Couldn’t change that setting. Please try again.'
                if (status) status.textContent = message
                showCopyToast(message)
                return
            }

            const enabled = resp.savingsSyncEnabled
            e.target.checked = enabled
            await caramelSetSettings({ syncSavings: enabled })
            if (status)
                status.textContent = enabled
                    ? 'Savings sync is on'
                    : 'Savings sync is off'
            // Turning it on flushes anything already queued on this device.
            if (enabled) caramelSyncSavings()
        })

    caramelGetSession().then(({ token }) => {
        const link = document.getElementById('accountLink')
        if (link && token) link.style.display = 'inline-block'
    })

    const backBtn = document.getElementById('backBtn')
    if (backBtn && typeof backFn === 'function')
        backBtn.addEventListener('click', backFn)
}

/* Header gear → in-popup settings (works for guests too — the checkout
   prompt toggle matters most to signed-out users). */
function wireSettingsGear(backFn, domain) {
    const gear = document.getElementById('settingsIcon')
    if (!gear) return
    gear.style.display = 'block'
    gear.onclick = () => renderSettingsView(backFn, domain)
}

/* ------------------------------------------------------------ */
/*  Bootstrap                                                   */
/* ------------------------------------------------------------ */
/* Every top-level side effect this file used to run at script-eval time, in
   the order it ran them. The popup entrypoint calls this after the rest of
   the realm's inits (manifest/index.html order), which is what preserves
   today's script-order semantics. */
export function initPopupEntry() {
    CARAMEL_CALLER_ID = new URLSearchParams(location.search).get('callerId')

    document.addEventListener('DOMContentLoaded', async () => {
        const loader = document.getElementById('loading-container')
        // Anti-flicker floor, not a fetch-duration ceiling: a near-instant
        // response still shows the spinner for a beat, but initPopup() (below)
        // now actually awaits the fetch+render — so on a slow/degraded
        // connection the spinner correctly outlives 400ms instead of leaving a
        // blank auth-container gap while the real request is still in flight.
        const minDisplay = new Promise(resolve => setTimeout(resolve, 400))

        await Promise.all([initPopup(), minDisplay])

        if (loader) loader.style.display = 'none'
    })
}

/* ------------------------------------------------------------ */
/*  Init                                                        */
/* ------------------------------------------------------------ */
export async function initPopup() {
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

    // Wrapped in a Promise so initPopup() itself doesn't resolve until the
    // chosen render state has actually been painted (the storage APIs are
    // chrome-callback based, not natively awaitable) — the DOMContentLoaded
    // bootstrap above depends on that to know when the loader can come down.
    await new Promise(resolve => {
        caramelGetSession().then(async session => {
            const token = session?.token || null
            const user = session?.user || null

            // Fire the session check in PARALLEL with the coupon fetch below —
            // it must never add latency to the coupon render. A dead session
            // re-renders logged-out once the 401 lands.
            if (token) validateStoredSession(token, user)

            // Wrap the whole render: a fetch failure (backend down / offline) must
            // show an honest error state with a retry, NEVER leave the popup blank.
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
                        renderLoadError()
                        return
                    }
                    const coupons = page.coupons

                    if (coupons?.length) {
                        await renderCouponsView(coupons, user, domain, page)
                    } else {
                        renderUnsupportedSite(user, domain)
                    }
                    return
                }

                // no active tab info
                if (token) renderProfileCard(user)
                else renderUnsupportedSite(null)
            } catch {
                renderLoadError()
            } finally {
                resolve()
            }
        })
    })
}

/* Validates the stored session token against GET /api/extension/me. The
   stored token used to be trusted forever — a revoked/expired session kept
   showing a signed-in popup. Only a REAL 401 signs the user out (storage
   cleared, views re-rendered logged-out via initPopup); network failures
   and 5xx keep the session — offline must never log the user out. A 200
   refreshes the stored user {username, image} when the profile changed. */
function validateStoredSession(token, storedUser) {
    fetch(caramelUrl('api/extension/me'), {
        headers: { Authorization: `Bearer ${token}` },
    })
        .then(async res => {
            if (res.status === 401) {
                caramelClearSession(() => initPopup())
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
   what's happening and stop taking further presses. */
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

/* Network/backend failure state — keeps the popup from rendering blank when the
   coupon API is unreachable. Offers a retry that re-runs the whole init. */
export function renderLoadError() {
    const container = document.getElementById('auth-container')
    if (!container) return
    container.innerHTML = `
    <div class="no-coupons-view fade-in-up">
      <div class="empty-illu" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ea6925" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h.01"/>
          <path d="M8.5 16.4a5 5 0 0 1 7 0"/>
          <path d="M5 12.9a10 10 0 0 1 14 0"/>
          <path d="M2 9.5a16 16 0 0 1 20 0"/>
          <path d="M2 2l20 20"/>
        </svg>
      </div>
      <h3>Couldn't load coupons</h3>
      <p>Check your connection and try again.</p>
      <div class="no-coupons-actions">
        <button id="retryBtn" class="supported-sites-btn" type="button">Try again</button>
      </div>
    </div>`
    const retry = document.getElementById('retryBtn')
    if (retry)
        retry.addEventListener('click', () => {
            container.innerHTML = ''
            initPopup()
        })
}

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

/* ------------------------------------------------------------ */
/*  Unsupported-site view                                       */
/* ------------------------------------------------------------ */
/* Is this domain one we actually cover?
 *
 * "We have no codes for this store right now" and "we don't cover this store"
 * are different facts, and the view below used to render both as the latter.
 * A QA sweep on 2026-08-05 found huel.com — fully supported, with a complete
 * apply config — being told "No coupons for this site yet… see the ones we
 * support", with a button sending the user to a list containing the very store
 * they were standing on. Sampling 100 supported domains put roughly 1 in 8 in
 * that state, because the popup branched on coupons.length alone and never
 * consulted the supported-store list.
 *
 * Resolved asynchronously AFTER the view paints: this is a terminal state and
 * the honest wording is worth a moment's wait, but not at the cost of leaving
 * the popup blank while a network call completes.
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

export function renderUnsupportedSite(user, domain) {
    const container = document.getElementById('auth-container')

    /* Three different facts used to arrive at the same sentence.
     *
     * "No coupons for this site yet" is a claim ABOUT A SITE, and this view is
     * also where the popup lands when there is no site at all — opened on a new
     * tab, a PDF, a settings page, anywhere we cannot read a URL. A first-time
     * user's most likely first act is clicking the toolbar icon before going
     * shopping, and what they got was a verdict about a store they were not
     * standing in. (The third case, "we cover this store but nothing is working
     * right now", is resolved asynchronously below.)
     *
     * It is also the only place the popup can say what Caramel IS. Nothing in
     * this extension ever explains itself — QA's first-time users had to infer
     * the product from a pill that appears on a checkout — and the moment
     * someone opens it with no store in front of them is exactly when that
     * sentence is useful rather than in the way.
     */
    const noSite = !domain
    const heading = noSite
        ? 'Ready when you are'
        : 'No coupons for this site yet'
    const body = noSite
        ? 'Caramel finds coupon codes and tries them for you at checkout. Open a store’s cart and we’ll take it from there.'
        : 'We’re adding new stores all the time — see the ones we support.'

    container.innerHTML = `
    <div class="no-coupons-view fade-in-up">
      <div class="empty-illu" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
          stroke="#ea6925" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>
          <circle cx="7.5" cy="7.5" r="1.3" fill="#ea6925" stroke="none"/>
        </svg>
      </div>

      <h3 id="noCouponsHeading">${heading}</h3>
      <p id="noCouponsBody">${body}</p>

      <div class="no-coupons-actions">
        <a
          id="supportedStoresLink"
          href="${caramelUrl('supported-stores')}"
          class="supported-sites-btn"
          target="_blank"
          rel="noopener noreferrer"
        >View Supported Stores</a>

        ${
            user
                ? '<button id="logoutBtn" class="toggle-login-btn">Log out</button>'
                : '<button id="loginToggleBtn" class="toggle-login-btn">Log in</button>'
        }
      </div>

      <a
        class="oss-link"
        href="https://github.com/DevinoSolutions/caramel"
        target="_blank"
        rel="noopener noreferrer"
        title="All extension code is 100% open-source."
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.03.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.93.08 2.13.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
        </svg>
        <span>Open source</span>
      </a>
    </div>
  `

    /* wiring */
    // Tell the truth once we know it: a store we DO cover but have no live
    // codes for gets its own wording, and loses the "see the stores we
    // support" link — that link's whole premise is that this store isn't on
    // the list. Purely additive: if the lookup fails or the store really is
    // unsupported, the copy painted above stands unchanged.
    caramelDomainIsSupported(domain).then(supported => {
        if (!supported) return
        const headingEl = document.getElementById('noCouponsHeading')
        const bodyEl = document.getElementById('noCouponsBody')
        const link = document.getElementById('supportedStoresLink')
        if (!headingEl || !bodyEl) return
        headingEl.textContent = 'No working codes right now'
        bodyEl.textContent = `We cover ${domain}, but none of our codes for it are working at the moment. We'll keep looking.`
        if (link) link.remove()
    })

    wireSettingsGear(() => renderUnsupportedSite(user, domain), domain)

    const loginToggle = document.getElementById('loginToggleBtn')
    if (loginToggle)
        loginToggle.addEventListener('click', () =>
            renderSignInPrompt(() => renderUnsupportedSite(user, domain)),
        )

    const logout = document.getElementById('logoutBtn')
    if (logout)
        logout.addEventListener('click', () => {
            signOutAndRevoke(() => renderUnsupportedSite(null, domain), logout)
        })
}

/* ------------------------------------------------------------ */
/*  OAuth Social Sign-In Handler                                */
/* The ways an engine says "the user closed the sign-in window". Chrome sends
 * "The user did not approve access."; others word it as a cancellation. Kept
 * broad on purpose — mislabelling a real failure as a cancel is far cheaper
 * than telling someone who just clicked X that sign-in FAILED. */
const CARAMEL_OAUTH_CANCEL_RE =
    /did not approve|cancell?ed|closed by (the )?user/i

/* ------------------------------------------------------------ */
async function handleSocialSignIn(provider) {
    const errorBox = document.getElementById('loginErrorMessage')
    const googleBtn = document.getElementById('googleSignInBtn')
    const appleBtn = document.getElementById('appleSignInBtn')
    const button = provider === 'google' ? googleBtn : appleBtn

    // Disable BOTH providers, label only the one that was clicked. Disabling
    // just the clicked button let a second click start a queued flow behind
    // the first: both buttons read "Redirecting..." while exactly one window
    // existed, so the UI described a state the browser was not in. Only one
    // launchWebAuthFlow can be in flight, so the other provider is genuinely
    // unavailable until this one settles — say so by disabling it.
    for (const b of [googleBtn, appleBtn]) if (b) b.disabled = true
    if (button) {
        const span = button.querySelector('span')
        if (span) {
            span.textContent = 'Redirecting...'
        }
    }

    if (errorBox) {
        errorBox.style.display = 'none'
        errorBox.textContent = ''
    }

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
        if (errorBox) {
            errorBox.textContent = CARAMEL_OAUTH_CANCEL_RE.test(
                err?.message || '',
            )
                ? 'Sign-in was cancelled.'
                : `OAuth sign-in failed: ${err.message}`
            errorBox.style.display = 'block'
        }

        // Re-enable BOTH providers — the other one was disabled for the
        // duration of this attempt and must not stay stuck.
        for (const b of [googleBtn, appleBtn]) if (b) b.disabled = false
        if (button) {
            const span = button.querySelector('span')
            if (span) {
                span.textContent =
                    provider === 'google'
                        ? 'Sign in with Google'
                        : 'Sign in with Apple'
            }
        }
    }
}

// Popup OAuth needs identity.launchWebAuthFlow, which Firefox deliberately
// ships without (manifest-firefox.json has no `identity` permission — see
// the per-browser differences header in manifest-sync.test.ts). Capability
// check, not UA sniffing.
function popupOAuthSupported() {
    const identity = currentBrowser.identity || currentBrowser.chrome?.identity
    return !!(identity && identity.launchWebAuthFlow)
}

// OAuth fallback for browsers without popup OAuth (issue #139): open the
// website's login page in a tab; once the user signs in there, the
// website→extension session relay (coupon-runner.js caramel-ext-hello ↔
// ExtensionSessionRelay.tsx) lands the session in storage.sync, so the
// popup is signed in on its next open.
function openWebsiteSignIn() {
    currentBrowser.tabs.create({ url: caramelUrl('login') })
    window.close()
}

/* ------------------------------------------------------------ */
/*  Login prompt                                                */
/* ------------------------------------------------------------ */
export function renderSignInPrompt(backFn) {
    returnView = typeof backFn === 'function' ? backFn : null

    const container = document.getElementById('auth-container')

    container.innerHTML = `
    <div class="login-prompt fade-in-up">

      <div class="oauth-buttons">
        <button type="button" id="googleSignInBtn" class="oauth-button" disabled>
          <svg class="oauth-icon" width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.348 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
          </svg>
          <span>Sign in with Google</span>
        </button>
        <button type="button" id="appleSignInBtn" class="oauth-button" disabled>
          <svg class="oauth-icon" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
          </svg>
          <span>Sign in with Apple</span>
        </button>
      </div>

      ${
          popupOAuthSupported()
              ? ''
              : '<p class="oauth-note">Sign-in opens grabcaramel.com; the extension picks it up automatically.</p>'
      }

      <div class="oauth-divider">
        <span>or</span>
      </div>

      <form id="loginForm" class="login-form">
        <div id="loginErrorMessage" class="error-message" role="alert" style="display:none;"></div>

        <div>
          <label for="email">Email</label>
          <input type="email" id="email" autocomplete="email" required/>
        </div>

        <div>
          <label for="password">Password</label>
          <div class="password-field">
            <input type="password" id="password" autocomplete="current-password" required/>
            <button
              type="button"
              id="togglePasswordBtn"
              class="password-toggle"
              aria-label="Show password"
              aria-pressed="false"
            >
              <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <svg id="eyeOffIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none;">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <path d="m1 1 22 22"/>
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
              </svg>
            </button>
          </div>
        </div>

        <button type="submit" class="login-button">Log in</button>
      </form>

      <div id="resendVerificationContainer" style="display:none; text-align:center; margin-top:12px;">
        <a
          href="${caramelUrl('verify')}"
          target="_blank"
          rel="noopener noreferrer"
          class="resend-verification-btn"
          style="display:inline-block; text-decoration:none;"
        >
          Verify your email
        </a>
      </div>

      <p class="mt-6">
        Don't have an account?
        <a
          href="${caramelUrl('signup')}"
          target="_blank"
          rel="noopener noreferrer"
        >Sign Up</a>
      </p>

      ${
          returnView
              ? '<button id="backBtn" class="back-btn" type="button">← Back</button>'
              : ''
      }
    </div>
  `

    const settingsIcon = document.getElementById('settingsIcon')
    if (settingsIcon) settingsIcon.style.display = 'none'

    const backBtn = document.getElementById('backBtn')
    if (backBtn && returnView) backBtn.addEventListener('click', returnView)

    // Show/hide password toggle: flips the input type and keeps the
    // button's accessible state (aria-pressed/label) + icon in sync.
    const togglePasswordBtn = document.getElementById('togglePasswordBtn')
    if (togglePasswordBtn)
        togglePasswordBtn.addEventListener('click', () => {
            const passwordInput = document.getElementById('password')
            const eyeIcon = document.getElementById('eyeIcon')
            const eyeOffIcon = document.getElementById('eyeOffIcon')
            if (!passwordInput) return
            const reveal = passwordInput.type === 'password'
            passwordInput.type = reveal ? 'text' : 'password'
            togglePasswordBtn.setAttribute('aria-pressed', String(reveal))
            togglePasswordBtn.setAttribute(
                'aria-label',
                reveal ? 'Hide password' : 'Show password',
            )
            if (eyeIcon) eyeIcon.style.display = reveal ? 'none' : ''
            if (eyeOffIcon) eyeOffIcon.style.display = reveal ? '' : 'none'
        })

    const resendVerificationContainer = document.getElementById(
        'resendVerificationContainer',
    )

    // OAuth button handlers
    const googleSignInBtn = document.getElementById('googleSignInBtn')
    const appleSignInBtn = document.getElementById('appleSignInBtn')

    if (googleSignInBtn) {
        googleSignInBtn.disabled = false
        googleSignInBtn.addEventListener('click', () =>
            popupOAuthSupported()
                ? handleSocialSignIn('google')
                : openWebsiteSignIn(),
        )
    }

    if (appleSignInBtn) {
        appleSignInBtn.disabled = false
        appleSignInBtn.addEventListener('click', () =>
            popupOAuthSupported()
                ? handleSocialSignIn('apple')
                : openWebsiteSignIn(),
        )
    }

    const loginForm = document.getElementById('loginForm')
    loginForm?.addEventListener('submit', async e => {
        e.preventDefault()

        const errorBox = document.getElementById('loginErrorMessage')
        errorBox.style.display = 'none'
        errorBox.textContent = ''
        errorBox.style.color = ''
        if (resendVerificationContainer)
            resendVerificationContainer.style.display = 'none'

        try {
            const email = document.getElementById('email').value.trim()
            const password = document.getElementById('password').value

            const res = await fetch(caramelUrl('api/extension/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            })

            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                const error = data.error || 'Login failed'

                // Check if error is about email verification
                if (
                    error.toLowerCase().includes('verify') ||
                    error.toLowerCase().includes('verification') ||
                    error.toLowerCase().includes('not verified')
                ) {
                    if (resendVerificationContainer) {
                        resendVerificationContainer.style.display = 'block'
                    }
                }

                throw new Error(error)
            }

            const { token, username, image } = await res.json()
            const user = { username, image }

            caramelSetSession({ token, user }, () => afterLoginSuccess())
        } catch (err) {
            errorBox.textContent = `Login failed: ${err.message}`
            errorBox.style.display = 'block'
        }
    })
}

/* ------------------------------------------------------------ */
/*  Profile card                                                */
/* ------------------------------------------------------------ */
export function renderProfileCard(user) {
    const container = document.getElementById('auth-container')
    const avatar = user.image?.length
        ? user.image
        : 'assets/default-profile.png'

    // Reuses the coupons-view card language (avatar+@username row + logout)
    // so the two signed-in surfaces read as one design.
    container.innerHTML = `
    <div class="coupons-profile-card fade-in-up">
      <div class="coupons-profile-row">
        <div class="coupons-profile-info">
          <img src="${escHtml(avatar)}" class="coupons-profile-image" alt="avatar"/>
          <span class="coupons-user-label">@${escHtml(user.username)}</span>
        </div>
        <button id="logoutBtn" class="coupons-logout-button">Log out</button>
      </div>
      <div id="savingsSummary"></div>
      <p class="profile-signed-in-note">You're signed in — coupons appear automatically at checkout.</p>
    </div>
  `

    wireSettingsGear(() => renderProfileCard(user))
    renderSavingsSummary()

    const logoutBtn = document.getElementById('logoutBtn')
    if (logoutBtn)
        logoutBtn.addEventListener('click', () => {
            signOutAndRevoke(initPopup, logoutBtn)
        })
}

/* ------------------------------------------------------------ */
/*  Follow this store (favorites)                               */
/* ------------------------------------------------------------ */
// Stroke star when not following, filled when following — the popup's icon
// convention (16px, currentColor), so it inherits .coupons-logout-button's
// brand colour and its dark value from --cm-* with no colour of its own.
const FAVORITE_STAR_SVG = following => `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="${following ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z"/>
  </svg>`

/** Repaints the star for `following` — icon fill, aria-pressed, and the label
 * a screen reader reads. `aria-pressed` (not aria-checked): this is a toggle
 * BUTTON, not a switch. */
function paintFavoriteStoreButton(button, domain, following) {
    button.setAttribute('aria-pressed', following ? 'true' : 'false')
    const label = following ? `Unfollow ${domain}` : `Follow ${domain}`
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.innerHTML = FAVORITE_STAR_SVG(following)
}

/**
 * Wires the header star: asks the account what it follows, paints the true
 * state, then toggles on click. Every call goes through caramelSendMessage →
 * background.js, never a direct fetch — the bearer lives in the worker's read
 * path (getStoredToken), the one place any API call attaches it.
 *
 * DISABLED until the account answers, and it stays disabled if the answer never
 * comes (offline, dead session). An enabled star showing a guessed state invites
 * a click that writes the opposite of what the user is looking at; a brief
 * disabled beat does not, and following is not why the popup is open.
 */
function wireFavoriteStoreButton(domain) {
    const button = document.getElementById('favoriteStoreBtn')
    if (!button || !domain) return

    caramelSendMessage({ action: 'getFavoriteStores' })
        .then(resp => {
            if (!resp || resp.error || !Array.isArray(resp.favorites)) return
            // Suffix-tolerant match, the same predicate the settings view uses
            // for paused sites: the popup knows the tab hostname
            // ("shop.nike.com") while the account is keyed on the registrable
            // domain ("nike.com").
            const following = resp.favorites.some(
                f =>
                    f &&
                    typeof f.store === 'string' &&
                    (domain === f.store || domain.endsWith('.' + f.store)),
            )
            paintFavoriteStoreButton(button, domain, following)
            button.disabled = false
        })
        .catch(err => log('FAVORITES_LOAD_FAILED', err?.message))

    button.addEventListener('click', () => {
        if (button.disabled) return
        const next = button.getAttribute('aria-pressed') !== 'true'
        // Optimistic, then reconciled: both writes are idempotent, so the only
        // thing a failure has to undo is this local flip.
        paintFavoriteStoreButton(button, domain, next)
        button.disabled = true
        caramelSendMessage({
            action: 'setFavoriteStore',
            site: domain,
            favorite: next,
        })
            .then(resp => {
                if (!resp || resp.error)
                    throw new Error(resp?.error || 'failed')
                paintFavoriteStoreButton(
                    button,
                    domain,
                    Boolean(resp.favorited),
                )
                showCopyToast(
                    resp.favorited
                        ? `Following ${domain}`
                        : `Unfollowed ${domain}`,
                )
            })
            .catch(err => {
                paintFavoriteStoreButton(button, domain, !next)
                showCopyToast("Couldn't save that — please try again")
                log('FAVORITE_TOGGLE_FAILED', err?.message)
            })
            .finally(() => {
                button.disabled = false
            })
    })
}

/* ------------------------------------------------------------ */
/*  Coupons view                                                */
/* ------------------------------------------------------------ */

/* One coupon card. Extracted from renderCouponsView's template so the FIRST
 * page and every appended page are built by the same code — a second copy of
 * this markup is how an appended row quietly loses a badge or a warning. */
function couponItemHtml(c) {
    // Sourced from CaramelCoupons
    // (coupon-constants.generated.js — F-006) instead
    // of a hard-coded literal, so this can't re-drift
    // from the app's src/lib/coupons.ts. Read off
    // `window` until the WXT P1 port; the import now
    // carries the same guarantee structurally.
    const restrictedSet = new Set(CaramelCoupons.RESTRICTED_STATUSES)
    const isRestricted = restrictedSet.has(c.status)
    const isDead = c.status === 'invalid' || c.status === 'expired'
    let warning = ''
    if (isRestricted) {
        const baseMsg =
            c.status === 'category_restricted'
                ? 'Limited to specific categories'
                : c.status === 'seller_specific'
                  ? 'Only for items from a specific seller'
                  : c.status === 'valid_with_warning'
                    ? 'May have restrictions'
                    : 'Limited to specific items'
        const cartHint = c.cartCategory
            ? ` — your cart looks like <b>${escHtml(c.cartCategory)}</b>${c.cartCategorySecondary ? ` / ${escHtml(c.cartCategorySecondary)}` : ''}`
            : ''
        const verifierMsg = c.verificationMessage
            ? `<div class="coupon-restriction-detail">${escHtml(c.verificationMessage)}</div>`
            : ''
        warning = `
              <div class="coupon-restriction" title="${escHtml(c.verificationMessage || baseMsg)}">
                <span class="coupon-restriction-icon" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <path d="M12 9v4"/>
                    <path d="M12 17h.01"/>
                  </svg>
                </span>
                <span class="coupon-restriction-text">${baseMsg}${cartHint}</span>
                ${verifierMsg}
              </div>`
    }
    // Verification badge: green=verified, amber=restricted,
    // grey=not yet verified (grace), red=known not valid.
    // Labels + which status maps to which tier come from
    // CaramelCoupons.STATUS_META
    // (coupon-constants.generated.js, F-006); the tier
    // palette lives in styles.css as
    // .coupon-badge--<tier> classes on tokens (with dark
    // values — the app's coupon-card.tsx keeps its own
    // Tailwind equivalent; the 4-tier axis can't drift
    // the way the 9-status axis did).
    const meta = CaramelCoupons.STATUS_META[c.status]
    const badge = meta
        ? `<span class="coupon-badge coupon-badge--${meta.tier}" title="${escHtml(c.verificationMessage || '')}">${meta.label}</span>`
        : ''
    // App-owned trust signal (W1): "worked Xh ago" when
    // the extension last reported this coupon working
    // (<7 days). '' (unshown) until W2 wires the report.
    const workedAgo = formatWorkedAgo(c.lastWorkedAt)
    return `
            <div data-code="${escHtml(c.code)}" role="button" tabindex="0" aria-label="${escHtml((c.title || 'Coupon') + ' — copy code ' + c.code)}" class="coupon-item${isRestricted ? ' coupon-item-restricted' : ''}${isDead ? ' coupon-item-dead' : ''}">
              <div class="coupon-head">
                <div class="coupon-title">${escHtml(c.title || 'Untitled Coupon')}</div>
                ${badge}
                ${workedAgo ? `<span class="coupon-worked-ago">${escHtml(workedAgo)}</span>` : ''}
              </div>
              ${c.description ? `<div class="coupon-desc">${escHtml(c.description)}</div>` : ''}
              ${warning}
              <div class="coupon-code-row">
                <span class="coupon-code">${escHtml(c.code)}</span>
                <span class="coupon-copy">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="2"/>
                    <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  Copy
                </span>
              </div>
            </div>`
}

/* Identity of a coupon ACROSS requests, for the append dedupe.
 *
 * Offset paging over a live catalog is not a snapshot: an ingest between page 1
 * and page 2 can shift a row across the boundary and hand it to us twice. The
 * catalog id is the real identity; a code is the fallback for the rare row that
 * arrives without one, and is unique per store in practice. */
function couponIdentity(c) {
    return c?.id != null ? `id:${c.id}` : `code:${c?.code}`
}

/* How many consecutive all-duplicate pages to chase before handing the shopper
 * a button instead. Small on purpose: the point is to get past one shifted
 * page, not to walk a catalog the backend keeps re-serving. */
const COUPON_PAGE_EMPTY_LIMIT = 3

/* Guests see a teaser, not the catalog. OWNER RULE (2026-08-10): "for guests
 * dont show all coupons" — the full list, and the infinite scroll that walks
 * it, are signed-in features. Six rows is about two screens of the 320px
 * list: enough to prove the codes are real, small enough that signing in
 * visibly buys something. The gate only exists when it hides something — a
 * guest on a store with this many codes or fewer sees exactly what a member
 * sees. */
const GUEST_COUPON_LIMIT = 6

/* Bottom of a guest's capped list: name what's hidden and the one action that
 * reveals it. `total` is the CATALOG count — the same number a member's
 * scroll ends on — so the promise on the button is exactly what signing in
 * delivers. */
function couponGuestGateHtml(shown, total) {
    return `<div id="couponGuestGate" class="coupon-guest-gate">
        <p class="coupon-list-note">Showing ${shown} of ${total} codes</p>
        <button type="button" id="couponLoginGateBtn" class="supported-sites-btn">Log in to see all ${total} codes</button>
    </div>`
}

/* Wording for the bottom of the list. "N codes" counts what the CATALOG holds
 * for this store, which is the number the shopper is really asking about when
 * they scroll to the end. */
function couponListEndHtml(total) {
    return `<p class="coupon-list-note">${
        total === 1
            ? "That's the only code we have"
            : `You've seen all ${total} codes`
    }</p>`
}

/* Repaints the footer of the list for one of four states. It is also the
 * IntersectionObserver's target: giving it real height while more pages exist
 * (a ghost card, the same shimmer the popup opens with) is what makes crossing
 * into view a reliable signal, and it doubles as the "more is coming" cue. */
function paintCouponListFooter(footer, state, paging) {
    if (!footer) return
    footer.dataset.state = state
    if (state === 'loading' || state === 'idle') {
        footer.innerHTML =
            '<div class="skeleton skeleton-ticket" aria-hidden="true"></div>'
        footer.setAttribute('aria-busy', 'true')
    } else if (state === 'error') {
        // Quiet, not an error banner: the codes already on screen are still
        // good, and one tap retries. Spamming a failure over a working list
        // would be a worse trade than a button that says what it does.
        footer.removeAttribute('aria-busy')
        footer.innerHTML =
            '<button type="button" id="couponLoadMoreBtn" class="supported-sites-btn">Load more codes</button>'
    } else {
        footer.removeAttribute('aria-busy')
        footer.innerHTML = couponListEndHtml(paging.total)
    }
}

/* Fetches the next page and appends it. Every exit leaves the footer in a state
 * the shopper can act on — never a spinner that spins forever. */
async function loadMoreCoupons(paging) {
    if (paging.loading || !paging.hasMore) return
    const list = document.getElementById('couponList')
    const footer = document.getElementById('couponListFooter')
    if (!list || !footer) return
    paging.loading = true
    paintCouponListFooter(footer, 'loading', paging)
    try {
        const next = await fetchCouponsPage(
            paging.domain,
            '',
            '',
            paging.page + 1,
        )
        // Trust the server's own page number when it sends one — an offset it
        // clamped is the offset the rows actually came from, and resuming from
        // our optimistic guess instead would silently re-request the same page.
        paging.page =
            typeof next.page === 'number' ? next.page : paging.page + 1
        if (typeof next.total === 'number') paging.total = next.total
        paging.hasMore = next.hasMore === true

        const fresh = (next.coupons || []).filter(c => {
            const key = couponIdentity(c)
            if (paging.seen.has(key)) return false
            paging.seen.add(key)
            return true
        })
        if (fresh.length) {
            paging.empty = 0
            footer.insertAdjacentHTML(
                'beforebegin',
                fresh.map(couponItemHtml).join(''),
            )
        } else {
            paging.empty += 1
        }

        if (!paging.hasMore) {
            paintCouponListFooter(footer, 'end', paging)
            stopCouponPaging(paging)
            return
        }
        // A page that was entirely duplicates leaves the footer exactly where
        // it was, so the observer has no boundary left to cross and would wait
        // forever. Pull the next page ourselves — but only a few times, so a
        // backend insisting there is more while returning nothing new ends at a
        // button the shopper can press rather than in a loop.
        if (fresh.length) {
            paintCouponListFooter(footer, 'idle', paging)
        } else if (paging.empty >= COUPON_PAGE_EMPTY_LIMIT) {
            paintCouponListFooter(footer, 'error', paging)
        } else {
            paintCouponListFooter(footer, 'idle', paging)
            paging.loading = false
            await loadMoreCoupons(paging)
        }
    } catch (err) {
        log('COUPON_PAGE_FAILED', err?.message)
        paintCouponListFooter(footer, 'error', paging)
    } finally {
        paging.loading = false
    }
}

function stopCouponPaging(paging) {
    if (paging.observer) {
        paging.observer.disconnect()
        paging.observer = null
    }
}

/* Wires the footer up. The observer is the intended path — it works in an
 * extension popup, with the scrolling .coupon-list itself as the root — and the
 * button is what a realm without IntersectionObserver gets instead. Both end up
 * calling the same loader, and the button is ALSO what a failed page falls back
 * to, so the retry affordance is never a second implementation. */
function wireCouponPaging(paging) {
    const list = document.getElementById('couponList')
    const footer = document.getElementById('couponListFooter')
    if (!list || !footer || !paging.hasMore) return

    // One delegated listener for the footer, so the retry button keeps working
    // no matter how many times the footer is repainted.
    footer.addEventListener('click', e => {
        if (e.target.closest('#couponLoadMoreBtn')) loadMoreCoupons(paging)
    })

    if (typeof IntersectionObserver !== 'function') {
        paintCouponListFooter(footer, 'error', paging)
        return
    }
    paging.observer = new IntersectionObserver(
        entries => {
            if (entries.some(entry => entry.isIntersecting))
                loadMoreCoupons(paging)
        },
        // rootMargin pulls the trigger a card's height early so the next page
        // is usually already there when the shopper reaches the bottom.
        { root: list, rootMargin: '120px' },
    )
    paging.observer.observe(footer)
}

export function renderCouponsView(coupons, user, domain, meta) {
    const container = document.getElementById('auth-container')

    /* Paging state for THIS render. `meta` is the envelope initPopup got with
     * page 1; without it (every caller that just wants a list painted) the view
     * behaves exactly as it did before paging existed — one page, no footer. */
    const paging = {
        domain,
        page: typeof meta?.page === 'number' ? meta.page : 1,
        total: typeof meta?.total === 'number' ? meta.total : coupons.length,
        hasMore: meta?.hasMore === true && coupons.length > 0,
        loading: false,
        empty: 0,
        seen: new Set(coupons.map(couponIdentity)),
        observer: null,
    }

    /* Guest cap (GUEST_COUPON_LIMIT): slice AFTER the paging state is built so
     * `paging.total` still carries the real catalog size the gate advertises.
     * hasMore is forced off — the gate replaces the pager, so a guest's list
     * never grows past the teaser no matter how the shopper scrolls. */
    const guestGated = !user && paging.total > GUEST_COUPON_LIMIT
    const visibleCoupons = guestGated
        ? coupons.slice(0, GUEST_COUPON_LIMIT)
        : coupons
    if (guestGated) paging.hasMore = false

    const headerLeft = user
        ? `
        <img
          src="${escHtml(user.image?.length ? user.image : 'assets/default-profile.png')}"
          class="coupons-profile-image"
          alt="avatar"
        />
        <span class="coupons-user-label">@${escHtml(user.username)}</span>
      `
        : `
        <img src="assets/default-profile.png" class="coupons-profile-image" alt="avatar"/>
        <span class="coupons-user-label">Guest</span>
      `

    // Follow-this-store star. SIGNED-IN ONLY: a guest tapping a star only to be
    // bounced into a sign-in form is a bad first touch, and this header already
    // branches on `user`. It sits INSIDE the existing header row (never its own
    // row) and reuses .coupons-logout-button, so the row's height is unchanged —
    // popup-sizing.test.mjs pins .coupon-list's 320px cap against everything
    // stacked above it, and a taller header is what would break that. Starts
    // unpressed + disabled; wireFavoriteStoreButton() corrects it.
    const favoriteButton = user
        ? `<button id="favoriteStoreBtn" class="coupons-logout-button coupons-icon-button" type="button" aria-pressed="false" aria-label="Follow ${escHtml(domain)}" title="Follow ${escHtml(domain)}" disabled>
             ${FAVORITE_STAR_SVG(false)}
           </button>`
        : ''

    const headerRight = user
        ? `<div class="coupons-header-actions">${favoriteButton}<button id="logoutBtn" class="coupons-logout-button">Log out</button></div>`
        : '<button id="loginToggleBtn" class="coupons-logout-button">Log in</button>'

    container.innerHTML = `
    <div class="coupons-profile-card fade-in-up">
      <div class="coupons-profile-row">
        <div class="coupons-profile-info">${headerLeft}</div>
        ${headerRight}
      </div>

      <div id="savingsSummary"></div>

      <h3 class="coupon-header">Coupons for ${escHtml(domain)}</h3>

      <div id="couponList" class="coupon-list">
        ${
            coupons.length === 0
                ? '<p>No coupons available for this store right now.</p>'
                : visibleCoupons.map(couponItemHtml).join('')
        }
        ${paging.hasMore ? '<div id="couponListFooter" class="coupon-list-footer"></div>' : ''}
        ${guestGated ? couponGuestGateHtml(visibleCoupons.length, paging.total) : ''}
      </div>
    </div>

    <div id="toastContainer" class="copy-toast-container" aria-live="polite"></div>
  `

    /* save callback for login back-button */
    const selfCallback = () => renderCouponsView(coupons, user, domain, meta)

    /* Settings gear (header): in-popup settings, guests included. */
    wireSettingsGear(selfCallback, domain)

    /* lifetime savings banner (renders only when there's history) */
    renderSavingsSummary()

    /* logout */
    const logoutBtn = document.getElementById('logoutBtn')
    if (logoutBtn)
        logoutBtn.addEventListener('click', () => {
            signOutAndRevoke(() => renderSignInPrompt(selfCallback), logoutBtn)
        })

    /* follow-this-store star (signed-in only; the element simply isn't in the
       markup for a guest, so this is a no-op there) */
    wireFavoriteStoreButton(domain)

    /* login toggle (guest) */
    const loginToggle = document.getElementById('loginToggleBtn')
    if (loginToggle)
        loginToggle.addEventListener('click', () =>
            renderSignInPrompt(selfCallback),
        )

    /* guest gate at the foot of the capped list — same destination as the
       header Log in button, offered where the capped list actually ends */
    const gateBtn = document.getElementById('couponLoginGateBtn')
    if (gateBtn)
        gateBtn.addEventListener('click', () =>
            renderSignInPrompt(selfCallback),
        )

    /* copy-to-clipboard (mouse + keyboard). Robust copy: async clipboard API
       with an execCommand fallback (shared caramelCopyText from UI-helpers.js).
       The bare navigator.clipboard path silently did nothing when the API was
       blocked — now the user always gets either the code on the clipboard or
       honest feedback instead of a dead click.

       Bound ONCE on the list, not per card: rows arriving from page 2 onward
       are appended straight into this container and would otherwise be
       decorative — a coupon you can see, click, and not copy. Delegation means
       a row is wired the moment it exists, with no re-bind step to forget. */
    const copyFromItem = async item => {
        const code = item.getAttribute('data-code')
        const ok = await caramelCopyText(code)
        showCopyToast(
            ok
                ? `Copied "${code}" to clipboard!`
                : `Couldn't copy — code is ${code}`,
        )
    }
    const list = document.getElementById('couponList')
    if (list) {
        list.addEventListener('click', e => {
            const item = e.target.closest?.('.coupon-item')
            if (item) copyFromItem(item)
        })
        // Keyboard users / screen readers: the card is role="button", so
        // Enter and Space must activate it like a real button.
        list.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar')
                return
            const item = e.target.closest?.('.coupon-item')
            if (!item) return
            e.preventDefault()
            copyFromItem(item)
        })
    }

    /* Depth: keep loading pages as the shopper scrolls (see wireCouponPaging). */
    wireCouponPaging(paging)
}

/* ------------------------------------------------------------ */
/*  Toast helper                                                */
/* ------------------------------------------------------------ */
function showCopyToast(message) {
    const host = document.getElementById('toastContainer')
    if (!host) return

    const toast = document.createElement('div')
    toast.className = 'copy-toast'
    toast.textContent = message
    host.appendChild(toast)

    setTimeout(() => {
        toast.classList.add('fade-out')
        toast.addEventListener('animationend', () => toast.remove())
    }, 2000)
}
