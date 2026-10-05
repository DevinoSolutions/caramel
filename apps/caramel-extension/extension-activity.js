// Daily-active-installation ping — Google Chrome only, popup-open only.
//
// The app owns the contract (apps/caramel-app/src/lib/extensionActivity.ts);
// the values this file needs arrive through the generated constants module, so
// the request it builds and the answers it reads cannot drift from the route.
//
// Privacy model, in the order things happen:
//   1. A 32-byte random SEED is created once per installation and kept in
//      storage.LOCAL (never storage.sync: it must not roam to other devices,
//      or two machines would share one id). It never leaves the browser.
//   2. dailyId = SHA-256(ID_DOMAIN \0 seed \0 UTC day), hex. It rotates at UTC
//      midnight, and two days of one installation cannot be linked by anyone
//      who lacks the seed — the server included. Signing in or out does not
//      change it, so it never counts one installation twice in a day.
//   3. The worker POSTs {dailyId, day, extensionVersion, browser} once. The
//      stored session bearer rides along (fetchCaramelApi) only so the SERVER
//      can derive a signed_in boolean; nothing about the account reaches
//      analytics. No URL, domain, coupon or browsing data is in the request.
//
// Delivery: only the route's explicit `recorded` answer marks today done. A
// `disabled` answer (server kill switch / analytics off) or any failure sets a
// cooldown instead, so a popup opened every minute does not ping every minute,
// and nothing ever retries on its own: the next eligible popup open is the
// retry. A cooldown never outlives its UTC day.
import { CaramelExtensionActivity } from './coupon-constants.generated.js'

const SEED_KEY = 'caramel_activity_seed'
const STATE_KEY = 'caramel_activity_state'
const ACTIVITY_DISABLED_COOLDOWN_MS = 6 * 60 * 60 * 1000
const ACTIVITY_FAILURE_COOLDOWN_MS = 30 * 60 * 1000

/* Is this the Google Chrome browser? The Chrome build also ships, unchanged,
 * to Edge and (converted) to Safari, so the build flag alone cannot answer it.
 *
 *   buildBrowser — WXT's import.meta.env.BROWSER: rules out the Firefox build.
 *   isSafari     — caramel-base.js isSafariExtensionRuntime() (the extension
 *                  origin's scheme): rules out the Safari conversion.
 *   brands       — navigator.userAgentData.brands (User-Agent Client Hints).
 *                  Google Chrome is the only browser that reports the
 *                  "Google Chrome" brand; Edge adds "Microsoft Edge", Opera
 *                  "Opera", Brave/Vivaldi/Chromium report no Chrome brand.
 *                  The rest of the list must be "Chromium" or a GREASE brand
 *                  ("Not A;Brand" and its rotating spellings), so any other
 *                  vendor brand riding alongside Chrome's is excluded too.
 *
 * Limits (documented in RUNBOOK.md): a fork that deliberately spoofs the
 * Google Chrome brand list is indistinguishable and is counted; a runtime
 * without userAgentData is excluded rather than guessed at. */
const GREASE_BRAND = /^not[^a-z0-9]*a[^a-z0-9]*brand$/i
export function isGoogleChromeRuntime({ buildBrowser, isSafari, brands }) {
    if (buildBrowser !== 'chrome' || isSafari) return false
    if (!Array.isArray(brands)) return false
    const names = brands.map(b => String(b?.brand ?? '').trim())
    if (!names.includes('Google Chrome')) return false
    return names.every(
        n => n === 'Google Chrome' || n === 'Chromium' || GREASE_BRAND.test(n),
    )
}

const utcDay = ms => new Date(ms).toISOString().slice(0, 10)

const toHex = bytes =>
    Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

async function deriveDailyId(seed, day) {
    const input = new TextEncoder().encode(
        `${CaramelExtensionActivity.ID_DOMAIN}\0${seed}\0${day}`,
    )
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))
}

/* The worker-side recorder. Built once per worker lifetime by background.js
 * with that realm's helpers; a restarted worker builds a new one and picks the
 * seed and the recorded day back up from storage.
 *
 *   storageLocal — the browser's storage.local area (callback API)
 *   lastError    — () => runtime.lastError
 *   fetchApi     — background.js fetchCaramelApi (bearer + timeout)
 *   apiUrl       — background.js caramelUrl
 *   version      — the manifest version string
 *   logError     — background.js logError (never handed an id) */
export function createActivityRecorder({
    storageLocal,
    lastError,
    fetchApi,
    apiUrl,
    version,
    logError,
    now = Date.now,
}) {
    // storage.local's callback API as a promise that rejects on lastError.
    const store = (op, arg) =>
        new Promise((resolve, reject) =>
            storageLocal[op](arg, res => {
                const err = lastError()
                if (err) reject(new Error(err.message || String(err)))
                else resolve(res)
            }),
        )

    async function attempt() {
        const day = utcDay(now())
        const saved = await store('get', [SEED_KEY, STATE_KEY])
        const state = saved?.[STATE_KEY] || {}
        if (state.recordedDay === day) return { outcome: 'already-recorded' }
        if (state.retryDay === day && now() < state.retryAfter)
            return { outcome: 'cooldown' }

        let seed = saved?.[SEED_KEY]
        if (!/^[0-9a-f]{64}$/.test(seed)) {
            seed = toHex(crypto.getRandomValues(new Uint8Array(32)))
            await store('set', { [SEED_KEY]: seed })
        }

        // Network failure, the fetch budget's abort, or an unreadable body all
        // land in `failure`; so does any answer other than recorded/disabled.
        let status, failure
        try {
            const response = await fetchApi(
                apiUrl(CaramelExtensionActivity.PATH),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        dailyId: await deriveDailyId(seed, day),
                        day,
                        extensionVersion: version,
                        browser: CaramelExtensionActivity.BROWSER,
                    }),
                },
            )
            const body = await response.json().catch(() => null)
            status = response.ok ? body?.status : undefined
            failure = new Error(
                `activity HTTP ${response.status}${body?.status ? ` ${body.status}` : ''}`,
            )
        } catch (err) {
            failure = err
        }

        const { RECORDED, DISABLED } = CaramelExtensionActivity.STATUS
        if (status === RECORDED) {
            await store('set', { [STATE_KEY]: { recordedDay: day } })
            return { outcome: 'recorded' }
        }
        const disabled = status === DISABLED
        await store('set', {
            [STATE_KEY]: {
                retryDay: day,
                retryAfter:
                    now() +
                    (disabled
                        ? ACTIVITY_DISABLED_COOLDOWN_MS
                        : ACTIVITY_FAILURE_COOLDOWN_MS),
            },
        })
        if (disabled) return { outcome: 'disabled' }
        logError('recordExtensionActivity', failure)
        return { outcome: 'failed' }
    }

    // One attempt at a time: popups opened back to back share the in-flight
    // attempt (and its seed creation) instead of racing it.
    let inflight = null
    return function recordActivity() {
        if (!inflight) {
            inflight = attempt().finally(() => {
                inflight = null
            })
        }
        return inflight
    }
}
