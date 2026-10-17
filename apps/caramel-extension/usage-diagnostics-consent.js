// owns: the anonymous-usage-diagnostics CONSENT record (usageDiagnosticsConsent
// in chrome.storage.LOCAL), the per-device telemetry id that exists only while
// that consent stands, and the Firefox data-collection grant that must back it.
//
// WHY A SECOND CONSENT. Reporting where the code-sharing offer drops shoppers
// (code-share-funnel.js) is data leaving the browser that is not needed to
// run Caramel, so it is OFF until the shopper says yes to a small card in the
// popup (or switches the Settings toggle on, which is the same explicit yes).
// Absent, malformed, declined, or another prompt version all parse to "no".
//
// LOCAL, NOT SYNCED (owner review 2026-10-15): a yes given on one device must
// never switch diagnostics on at another through the browser account, so the
// record lives in storage.local and each device is asked for itself. Any record
// an earlier build left in storage.sync is never read.
//
// It is deliberately NOT the code-sharing consent (code-sharing-consent.js):
// sharing a code and sending diagnostics are different questions, and a yes to
// one must never stand in for the other.
//
// Shape: { choice: 'accepted' | 'declined', at: ISO-8601 string, promptVersion: 1 }
// Bump USAGE_DIAGNOSTICS_PROMPT_VERSION when the card's meaning changes: every
// shopper is asked again, by construction (same rule as the sharing record).
//
// THE TELEMETRY ID (storage.local): a random UUID minted ONLY on the accept
// path (writeUsageDiagnosticsConsent), sent as the PostHog distinct id so one
// device's steps join up. The report path only ever READS it (a missing id means
// "skip", never "mint"), so a report racing a withdrawal cannot resurrect it. It
// is NOT the install id (`iid`, install-attribution.js, which is tied to the
// sign-up) and never a user id; withdrawing consent deletes it, so a later opt-in
// starts a new, unlinked id.
//
// FIREFOX. The manifest lists `technicalAndInteraction` as an OPTIONAL data
// collection permission (wxt.config.ts); Firefox shows its own prompt when we
// ask for it, and nothing may be sent without it. Chrome/Edge/Safari have no
// such permission, so for them the consent record is the whole gate.
//
// Pure: callers pass the browser handle; no DOM, no top-level effects, so this
// is safe in the service worker, the popup and the content script.
import { getPermissionsApi } from './permissions-api.js'

export const USAGE_DIAGNOSTICS_CONSENT_KEY = 'usageDiagnosticsConsent'
const USAGE_DIAGNOSTICS_PROMPT_VERSION = 1
// storage.local key: the telemetry id (a bare UUID string) while consent stands.
export const USAGE_DIAGNOSTICS_ID_KEY = 'caramel_usage_diagnostics_id'
const FIREFOX_DATA_PERMISSION = { data_collection: ['technicalAndInteraction'] }

export function usageDiagnosticsPromptVersion() {
    return USAGE_DIAGNOSTICS_PROMPT_VERSION
}

// Stored value -> the record, or null when it is not exactly a valid record.
export function parseUsageDiagnosticsConsent(raw) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.choice !== 'accepted' && raw.choice !== 'declined') return null
    if (raw.promptVersion !== USAGE_DIAGNOSTICS_PROMPT_VERSION) return null
    if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at)))
        return null
    return { choice: raw.choice, at: raw.at, promptVersion: raw.promptVersion }
}

export function usageDiagnosticsAccepted(record) {
    return record?.choice === 'accepted'
}

function storageCall(browser, area, method, arg, what) {
    return new Promise((resolve, reject) => {
        try {
            browser.storage[area][method](arg, res => {
                const err = browser.runtime.lastError
                if (err) {
                    reject(new Error(`${what} failed: ${err.message}`))
                    return
                }
                resolve(res)
            })
        } catch (err) {
            reject(err)
        }
    })
}

// Resolves the parsed record (null when none). REJECTS when storage itself
// fails; every caller treats a rejection as "no consent" after reporting it.
export async function readUsageDiagnosticsConsent(browser) {
    const res = await storageCall(
        browser,
        'local',
        'get',
        [USAGE_DIAGNOSTICS_CONSENT_KEY],
        'usage-diagnostics consent read',
    )
    return parseUsageDiagnosticsConsent(res?.[USAGE_DIAGNOSTICS_CONSENT_KEY])
}

export async function readTelemetryId(browser) {
    const res = await storageCall(
        browser,
        'local',
        'get',
        [USAGE_DIAGNOSTICS_ID_KEY],
        'usage-diagnostics id read',
    )
    const id = res?.[USAGE_DIAGNOSTICS_ID_KEY]
    return typeof id === 'string' && id !== '' ? id : null
}

// The id for this device. ONLY the accept path (writeUsageDiagnosticsConsent)
// calls this. `reuse` is true only while consent already stands: a stored id is
// kept then. Coming from declined/absent, any stored id is a leftover from a
// withdrawal whose delete failed, so it is overwritten with a fresh UUID: an id
// is never reused after a deletion attempt, whether or not the delete worked.
async function ensureTelemetryId(browser, reuse) {
    if (reuse) {
        const existing = await readTelemetryId(browser)
        if (existing) return existing
    }
    const id = crypto.randomUUID()
    await storageCall(
        browser,
        'local',
        'set',
        { [USAGE_DIAGNOSTICS_ID_KEY]: id },
        'usage-diagnostics id write',
    )
    return id
}

export function deleteTelemetryId(browser) {
    return storageCall(
        browser,
        'local',
        'remove',
        [USAGE_DIAGNOSTICS_ID_KEY],
        'usage-diagnostics id delete',
    )
}

// Records the shopper's choice. Resolves the stored record; REJECTS if it could
// not be persisted — a "yes" that was never saved must not be acted on. The
// record is what every send reads, so the order is chosen to fail closed both
// ways: an ACCEPT mints the id first and publishes the record second (a report
// can never see "accepted" without an id to send under; a failed record write
// leaves only an inert, unsent id), while a DECLINE writes the record first and
// deletes the id second (sends stop at once). If that delete rejects, the caller
// sees the rejection, and the leftover id is never reused: the next accept
// (from a non-accepted record) mints a fresh one over it.
export async function writeUsageDiagnosticsConsent(browser, choice) {
    if (choice !== 'accepted' && choice !== 'declined')
        throw new Error(`usage-diagnostics consent: unknown choice "${choice}"`)
    const record = {
        choice,
        at: new Date().toISOString(),
        promptVersion: USAGE_DIAGNOSTICS_PROMPT_VERSION,
    }
    if (choice === 'accepted') {
        const previous = await readUsageDiagnosticsConsent(browser)
        await ensureTelemetryId(browser, usageDiagnosticsAccepted(previous))
    }
    await storageCall(
        browser,
        'local',
        'set',
        { [USAGE_DIAGNOSTICS_CONSENT_KEY]: record },
        'usage-diagnostics consent write',
    )
    if (choice === 'declined') await deleteTelemetryId(browser)
    return record
}

function isFirefoxRuntime(browser) {
    return browser.runtime.getURL('').startsWith('moz-extension://')
}

// Withdrawal's other half on Firefox: hand the data-collection grant back to the
// browser so its own settings no longer show Caramel as allowed. A no-op off
// Firefox and when the grant is not held. REJECTS when the browser says it did
// not remove a held grant; the caller reports that (the consent record is
// already "declined", so nothing is sent either way).
export async function withdrawUsageDiagnosticsPermission(browser) {
    if (!isFirefoxRuntime(browser)) return
    const api = getPermissionsApi()
    if (!api)
        throw new Error('usage-diagnostics: no permissions API in this runtime')
    if (!(await api.contains(FIREFOX_DATA_PERMISSION))) return
    if ((await api.remove(FIREFOX_DATA_PERMISSION)) !== true)
        throw new Error(
            'usage-diagnostics: the browser did not remove the data-collection permission',
        )
}

// Ask the BROWSER for the data-collection grant. MUST be called straight out of
// a click (no await before it): permissions.request() is refused without a user
// gesture. Resolves true when held/granted, false when the shopper refused the
// browser's own prompt. Chrome/Edge/Safari have no such permission: true.
// REJECTS on a Firefox too old to know `data_collection` (the caller says so
// and records nothing).
export async function requestUsageDiagnosticsPermission(browser) {
    if (!isFirefoxRuntime(browser)) return true
    const api = getPermissionsApi()
    if (!api)
        throw new Error('usage-diagnostics: no permissions API in this runtime')
    // Still synchronous with the click: an async function runs up to its first
    // await before returning, and the request is issued before any await.
    return api.request(FIREFOX_DATA_PERMISSION)
}

// Does the browser hold the grant right now? true off Firefox. REJECTS where it
// cannot tell (callers fail closed).
export async function usageDiagnosticsBrowserPermitted(browser) {
    if (!isFirefoxRuntime(browser)) return true
    const api = getPermissionsApi()
    if (!api)
        throw new Error('usage-diagnostics: no permissions API in this runtime')
    const held = await api.contains(FIREFOX_DATA_PERMISSION)
    if (typeof held !== 'boolean')
        throw new Error(
            'usage-diagnostics: permissions.contains gave no boolean',
        )
    return held
}

// The ONE gate: consent accepted AND the browser grant held. Resolves the
// consent record when sends are allowed, else null. Rejects when storage or the
// permissions API fails — loud, and never a "yes".
export async function resolveUsageDiagnostics(browser) {
    const record = await readUsageDiagnosticsConsent(browser)
    if (!usageDiagnosticsAccepted(record)) return null
    return (await usageDiagnosticsBrowserPermitted(browser)) ? record : null
}
