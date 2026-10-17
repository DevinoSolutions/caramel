// Install attribution: the one place the extension keeps (and later hands to
// the server) where this install came from.
//
// WHY IT EXISTS. An extension sign-up used to reach the server with no
// attribution at all: the extension's fetch carries none of the site's cookies,
// so the server saw no `cm_ft` first-touch record and no PostHog id, and every
// extension account landed as source 'unknown' (82 of 160 sign-ups in the last
// 30 days). The attribution does exist, though, on the page the extension opens
// right after install, /welcome (our own origin, where the first-party `cm_ft`
// cookie is readable). This module is how it gets from there to the sign-in:
//
//   background  onInstalled   mints the install id, saves { iid }   (saveInstallId)
//   content     on /welcome   adds the page's first-touch record    (recordWelcomeFirstTouch)
//   popup       OAuth sign-in sends { iid, firstTouch } with the code exchange
//                                                                   (installAttributionFields)
//
// ONE storage key, written by the two realms above in that order; the server
// validates what it receives with the same definitions as the website
// (apps/caramel-app/src/lib/analytics/firstTouchRecord.ts and extensionInstall.ts).
// The field list and patterns below are pinned to them by
// tests/install-attribution.test.mjs, the way tests/install-welcome.test.mjs
// pins the store vocabulary.
//
// No permissions are added: the content script already runs on https://*/*
// and reads document.cookie of the page it is on, here only on /welcome.
//
// No top-level side effects (the content realm bundles this beside the rest);
// every function takes the browser API handle so the background worker, which
// cannot load caramel-base.js, can use it too.

/** storage.local key: `{ iid, firstTouch? }`. Absent on installs older than this module. */
export const INSTALL_ATTRIBUTION_KEY = 'caramel_install_attribution'

/** The site's first-party first-touch cookie (FIRST_TOUCH_COOKIE_NAME). */
const FIRST_TOUCH_COOKIE_PREFIX = 'cm_ft='

/** `crypto.randomUUID()` output (INSTALL_ID_PATTERN). */
const INSTALL_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** FIRST_TOUCH_MAX_VALUE_LENGTH */
const MAX_LABEL_LENGTH = 255

/** FIRST_TOUCH_PARAMS + referrer_domain + landing_path: every optional label of the record. */
const LABEL_FIELDS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'ref',
    'gclid',
    'gbraid',
    'wbraid',
    'fbclid',
    'msclkid',
    'ttclid',
    'referrer_domain',
    'landing_path',
]

const MAX_CAPTURED_AT_LENGTH = 64

/** The record as the server's schema reads it, or why this value is not one. */
function parseRecordValue(raw) {
    let json
    try {
        json = JSON.parse(decodeURIComponent(raw))
    } catch (err) {
        return { reason: `not URL-encoded JSON (${err.message})` }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json))
        return { reason: 'not an object' }
    const capturedAt = json.captured_at
    if (
        typeof capturedAt !== 'string' ||
        capturedAt.length < 1 ||
        capturedAt.length > MAX_CAPTURED_AT_LENGTH
    )
        return { reason: 'captured_at missing or too long' }
    const record = { captured_at: capturedAt }
    for (const field of LABEL_FIELDS) {
        const value = json[field]
        if (value === undefined) continue
        if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH)
            return { reason: `${field} is not a short string` }
        record[field] = value
    }
    return { record }
}

/**
 * The first valid `cm_ft` record in a `document.cookie` string. A host-only
 * and an apex cookie of the same name can coexist, so each is tried in order.
 * `invalid` lists the reasons of values that did not validate, so the caller
 * can report them instead of treating them as absent.
 */
export function readFirstTouchCookie(cookieString) {
    const invalid = []
    for (const part of (cookieString || '').split(';')) {
        const trimmed = part.trim()
        if (!trimmed.startsWith(FIRST_TOUCH_COOKIE_PREFIX)) continue
        const parsed = parseRecordValue(
            trimmed.slice(FIRST_TOUCH_COOKIE_PREFIX.length),
        )
        if (parsed.record) return { record: parsed.record, invalid }
        invalid.push(parsed.reason)
    }
    return { record: null, invalid }
}

/** The install id on a /welcome URL the extension itself opened, else null. */
export function welcomeInstallId(href, trustedOrigins) {
    let url
    try {
        url = new URL(href)
    } catch {
        return null
    }
    if (!trustedOrigins.has(url.origin) || url.pathname !== '/welcome')
        return null
    if (url.searchParams.get('src') !== 'ext') return null
    const iid = url.searchParams.get('iid')
    return iid && INSTALL_ID_PATTERN.test(iid) ? iid : null
}

function storageGet(api) {
    return new Promise((resolve, reject) => {
        api.storage.local.get([INSTALL_ATTRIBUTION_KEY], res => {
            if (api.runtime.lastError) reject(api.runtime.lastError)
            else resolve(res?.[INSTALL_ATTRIBUTION_KEY] || null)
        })
    })
}

function storageSet(api, value) {
    return new Promise((resolve, reject) => {
        api.storage.local.set({ [INSTALL_ATTRIBUTION_KEY]: value }, () => {
            if (api.runtime.lastError) reject(api.runtime.lastError)
            else resolve()
        })
    })
}

/**
 * Background, on a first install: remember this install's id. Replaces any
 * earlier record (a reinstall is a new install with a new id and a new
 * welcome page). Rejects when storage refuses; the caller reports it.
 */
export function saveInstallId(api, iid) {
    return storageSet(api, { iid })
}

/**
 * Content script, on /welcome: add the page's first-touch record to the stored
 * install. Resolves to a status so the caller (and the tests) can tell the
 * outcomes apart:
 *   'not-welcome'   this page is not our /welcome?src=ext&iid=.. (nothing to do)
 *   'other-install' storage holds a DIFFERENT install id (a stale welcome tab)
 *   'already'       the record was saved earlier
 *   'no-cookie'     no valid `cm_ft` yet (the page may not have written it)
 *   'saved'         stored; `invalid` carries any rejected cookie values seen
 */
export async function recordWelcomeFirstTouch(
    api,
    { href, cookie, trustedOrigins },
) {
    const iid = welcomeInstallId(href, trustedOrigins)
    if (!iid) return { status: 'not-welcome', invalid: [] }
    const stored = await storageGet(api)
    if (stored?.iid && stored.iid !== iid)
        return { status: 'other-install', invalid: [] }
    if (stored?.firstTouch) return { status: 'already', invalid: [] }
    const { record, invalid } = readFirstTouchCookie(cookie)
    if (!record) return { status: 'no-cookie', invalid }
    await storageSet(api, { iid, firstTouch: record })
    return { status: 'saved', invalid }
}

/**
 * Popup, at sign-in: the optional `iid` / `firstTouch` fields for the OAuth
 * exchange body (or authorize query). `{}` for an install that has neither,
 * which is also exactly what old builds sent.
 */
export async function installAttributionFields(api) {
    const stored = await storageGet(api)
    const fields = {}
    if (stored?.iid) fields.iid = stored.iid
    if (stored?.firstTouch) fields.firstTouch = stored.firstTouch
    return fields
}
