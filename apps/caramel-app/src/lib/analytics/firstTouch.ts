// src/lib/analytics/firstTouch.ts
//
// First-touch attribution capture. The FIRST page load in a browser records
// where the visitor came from — utm_*, ref/gclid/fbclid, the external
// referrer host and the landing path — into localStorage under
// `caramel.first_touch`, and that record is never overwritten afterwards:
// "first touch" is written once and read forever. identity.ts feeds it to
// PostHog `$set_once`, so a person profile keeps its original acquisition
// source even after a dozen later sessions arrive from somewhere else.
//
// The extractor is pure and takes plain strings, so the param mapping is
// testable in node; only `captureFirstTouch` reads window/localStorage, and
// it never throws — analytics must not be able to break a page render.
import * as Sentry from '@sentry/nextjs'

/** localStorage key holding the once-written first-touch record. */
export const FIRST_TOUCH_STORAGE_KEY = 'caramel.first_touch'

/** Query params we treat as attribution, in the order they are read. */
const FIRST_TOUCH_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'ref',
    'gclid',
    'fbclid',
] as const

/** The persisted record. Everything except `captured_at` is best-effort. */
export interface FirstTouchRecord {
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    utm_term?: string
    utm_content?: string
    ref?: string
    gclid?: string
    fbclid?: string
    referrer_domain?: string
    landing_path?: string
    captured_at: string
}

// Attribution values are labels, not payloads: a cap keeps a junk query
// string from ballooning the person profile it eventually lands on.
const MAX_VALUE_LENGTH = 255

/**
 * Normalise one raw param/path value: trim, reject the empty string and the
 * literal strings browsers/templating leave behind, and cap the length.
 */
function cleanValue(value: string | null | undefined): string | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const lowered = trimmed.toLowerCase()
    if (lowered === 'undefined' || lowered === 'null') return undefined
    return trimmed.slice(0, MAX_VALUE_LENGTH)
}

/**
 * Hostname of an EXTERNAL referrer. Same-origin referrers (our own internal
 * navigation) and unparseable values resolve to undefined rather than
 * recording ourselves as the acquisition source.
 */
export function referrerDomain(
    referrer: string | null | undefined,
    currentHost?: string,
): string | undefined {
    const raw = cleanValue(referrer)
    if (!raw) return undefined
    try {
        const { hostname } = new URL(raw)
        if (!hostname) return undefined
        if (currentHost && hostname === currentHost) return undefined
        return hostname
    } catch {
        return undefined
    }
}

/**
 * Pure: build the first-touch record from a landing URL. Only keys with a
 * real value are present — an organic visit yields just `landing_path` and
 * `captured_at`, which is exactly what a "we know nothing about the source"
 * record should look like.
 */
export function extractFirstTouch(input: {
    search: string
    pathname: string
    referrer?: string | null
    host?: string
    capturedAt?: string
}): FirstTouchRecord {
    const params = new URLSearchParams(input.search)
    const record: FirstTouchRecord = {
        captured_at: input.capturedAt ?? new Date().toISOString(),
    }

    for (const key of FIRST_TOUCH_PARAMS) {
        const value = cleanValue(params.get(key))
        if (value) record[key] = value
    }

    const domain = referrerDomain(input.referrer, input.host)
    if (domain) record.referrer_domain = domain

    const landingPath = cleanValue(input.pathname)
    if (landingPath) record.landing_path = landingPath

    return record
}

/** Shape guard for whatever JSON is sitting in localStorage today. */
function isFirstTouchRecord(value: unknown): value is FirstTouchRecord {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { captured_at?: unknown }).captured_at === 'string'
    )
}

// Per page load: `undefined` = not looked at yet, `null` = no browser.
// Avoids a localStorage round-trip on every identify call.
let cachedRecord: FirstTouchRecord | null | undefined

/**
 * Read the stored first-touch record, writing it from the current URL the
 * first time this browser ever loads the app. Never overwrites an existing
 * record and never throws: a blocked/full localStorage (private windows,
 * storage-partitioned iframes) degrades to an in-memory record for this page
 * load only.
 */
export function captureFirstTouch(): FirstTouchRecord | null {
    if (cachedRecord !== undefined) return cachedRecord
    if (typeof window === 'undefined') return null

    try {
        const raw = window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY)
        if (raw) {
            const parsed: unknown = JSON.parse(raw)
            if (isFirstTouchRecord(parsed)) {
                cachedRecord = parsed
                return parsed
            }
        }
    } catch (error) {
        // A corrupt/unreadable record must not stop us capturing a fresh one.
        console.error('[posthog] first-touch read failed', error)
        Sentry.captureException(error, {
            tags: { operation: 'posthog_first_touch_read' },
        })
    }

    const fresh = extractFirstTouch({
        search: window.location.search,
        pathname: window.location.pathname,
        referrer:
            typeof document === 'undefined' ? undefined : document.referrer,
        host: window.location.host,
    })

    try {
        window.localStorage.setItem(
            FIRST_TOUCH_STORAGE_KEY,
            JSON.stringify(fresh),
        )
    } catch (error) {
        console.error('[posthog] first-touch write failed', error)
        Sentry.captureException(error, {
            tags: { operation: 'posthog_first_touch_write' },
        })
    }

    cachedRecord = fresh
    return fresh
}
