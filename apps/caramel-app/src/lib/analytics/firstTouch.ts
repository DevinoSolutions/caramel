// src/lib/analytics/firstTouch.ts
//
// First-touch attribution capture. The FIRST page load in a browser records
// where the visitor came from — utm_*, ref and ad-platform click ids, the
// external referrer host and the landing path — and that record is never
// overwritten afterwards: "first touch" is written once and read forever.
//
// It lives in TWO places, deliberately:
//  - localStorage `caramel.first_touch` (the original store; identity.ts feeds
//    it to PostHog `$set_once` so a person profile keeps its original source);
//  - a first-party cookie `cm_ft` on the registrable apex (90 days, Lax). The
//    cookie is what makes the record reach the SERVER: the signup hook and
//    /api/ext/installed read it from the request, so a visitor whose browser
//    blocks or drops PostHog (the ad-blocker case this exists for) is still
//    attributed in our own database. It also survives across dev./apex hosts,
//    which localStorage never does.
// Either side missing is rebuilt from the other (cookie wins when both exist,
// because the server only ever sees the cookie); neither is ever overwritten.
//
// The extractor is pure and takes plain strings, so the param mapping is
// testable in node; only `captureFirstTouch` reads window/document/localStorage,
// and it never throws — analytics must not be able to break a page render.
import * as Sentry from '@sentry/nextjs'
import { readCookieValues } from './cookieHeader'
import {
    FIRST_TOUCH_COOKIE_MAX_AGE_SECONDS,
    FIRST_TOUCH_COOKIE_NAME,
    FIRST_TOUCH_MAX_VALUE_LENGTH,
    FIRST_TOUCH_PARAMS,
    parseFirstTouchCookieValue,
    parseFirstTouchRecord,
    serializeFirstTouchCookieValue,
    type FirstTouchRecord,
} from './firstTouchRecord'

export type { FirstTouchRecord } from './firstTouchRecord'

/** localStorage key holding the once-written first-touch record. */
export const FIRST_TOUCH_STORAGE_KEY = 'caramel.first_touch'

/**
 * Sign-in hops that sit BETWEEN the real source and our signup: arriving back
 * from Google's account chooser says nothing about where the visitor was
 * acquired (measured on sister products 2026-10-06: the Google sign-in page
 * showed up as the "referrer" of ~4% of signups). Not a source, so never
 * recorded as one.
 */
const AUTH_HOP_REFERRER_HOSTS: ReadonlySet<string> = new Set([
    'accounts.google.com',
    'accounts.youtube.com',
    'appleid.apple.com',
    'idmsa.apple.com',
    'login.microsoftonline.com',
    'login.live.com',
    'checkout.stripe.com',
])

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
    return trimmed.slice(0, FIRST_TOUCH_MAX_VALUE_LENGTH)
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * The registrable domain of one of OUR hosts: its last two labels
 * (`dev.grabcaramel.com` -> `grabcaramel.com`). Hosts with no registrable
 * domain — `localhost`, single-label hosts, IPv4/IPv6 literals — come back
 * unchanged. Two labels is correct for every host this app is served from; it
 * is NOT a public-suffix lookup (it would mis-split `x.co.uk`), and bundling
 * one into every page for a hostname we control is not worth ~20 KB. A browser
 * that rejects the derived cookie Domain is handled at write time.
 */
export function registrableDomain(host: string): string {
    const bare = host.toLowerCase().replace(/:\d+$/, '')
    if (bare.includes(':') || IPV4.test(bare)) return bare
    const labels = bare.split('.').filter(Boolean)
    if (labels.length <= 2) return bare
    return labels.slice(-2).join('.')
}

/**
 * Hostname of an EXTERNAL acquisition referrer, or undefined. Not a source:
 *  - our own site: same registrable domain as `currentHost` (so `dev.` and the
 *    apex count as one site, and `www.` as ours),
 *  - an auth hop (accounts.google.com, appleid.apple.com, ...),
 *  - a missing or unparseable value.
 */
export function referrerDomain(
    referrer: string | null | undefined,
    currentHost?: string,
): string | undefined {
    const raw = cleanValue(referrer)
    if (!raw) return undefined
    try {
        const hostname = new URL(raw).hostname.toLowerCase()
        if (!hostname) return undefined
        if (
            currentHost &&
            registrableDomain(hostname) === registrableDomain(currentHost)
        ) {
            return undefined
        }
        if (AUTH_HOP_REFERRER_HOSTS.has(hostname)) return undefined
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

/**
 * The cookie `Domain` attribute for `hostname`: `.grabcaramel.com` for any
 * grabcaramel.com host, so the apex, `www.` and `dev.` share one record. None
 * (host-only cookie) where there is no registrable domain to share.
 */
export function firstTouchCookieDomain(hostname: string): string | undefined {
    const apex = registrableDomain(hostname)
    if (apex === 'localhost' || !apex.includes('.') || apex.includes(':')) {
        return undefined
    }
    if (IPV4.test(apex)) return undefined
    return `.${apex}`
}

/**
 * Report a first-touch failure loudly (console + Sentry) and carry on:
 * attribution is best-effort, but a failure must never be silent.
 */
function reportFirstTouchFailure(operation: string, error: unknown): void {
    console.error(`[posthog] ${operation} failed`, error)
    Sentry.captureException(error, { tags: { operation } })
}

/** Cookie record, validated. Corrupt/foreign values are reported, not used. */
function readCookieRecord(): FirstTouchRecord | null {
    for (const raw of readCookieValues(
        document.cookie,
        FIRST_TOUCH_COOKIE_NAME,
    )) {
        const parsed = parseFirstTouchCookieValue(raw)
        if (parsed.ok) return parsed.record
        reportFirstTouchFailure(
            'posthog_first_touch_cookie_read',
            new Error(
                `invalid ${FIRST_TOUCH_COOKIE_NAME} cookie: ${parsed.reason}`,
            ),
        )
    }
    return null
}

/** localStorage record, validated. Corrupt values are reported, not used. */
function readStoredRecord(): FirstTouchRecord | null {
    try {
        const raw = window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY)
        if (!raw) return null
        const parsed = parseFirstTouchRecord(JSON.parse(raw))
        if (parsed.ok) return parsed.record
        throw new Error(`invalid stored first-touch record: ${parsed.reason}`)
    } catch (error) {
        // A corrupt/unreadable record must not stop us capturing a fresh one.
        reportFirstTouchFailure('posthog_first_touch_read', error)
        return null
    }
}

function writeStoredRecord(record: FirstTouchRecord): void {
    try {
        window.localStorage.setItem(
            FIRST_TOUCH_STORAGE_KEY,
            JSON.stringify(record),
        )
    } catch (error) {
        reportFirstTouchFailure('posthog_first_touch_write', error)
    }
}

function firstTouchCookiePresent(): boolean {
    return readCookieValues(document.cookie, FIRST_TOUCH_COOKIE_NAME).length > 0
}

/**
 * Write the cookie on the apex, falling back to a host-only cookie when the
 * browser refuses the derived Domain (verified by reading it back). Returns
 * whether a cookie is now present.
 */
function writeCookieRecord(record: FirstTouchRecord): boolean {
    const attributes = [
        'Path=/',
        `Max-Age=${FIRST_TOUCH_COOKIE_MAX_AGE_SECONDS}`,
        'SameSite=Lax',
        ...(window.location.protocol === 'https:' ? ['Secure'] : []),
    ]
    const cookie = `${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(record)}`
    const domain = firstTouchCookieDomain(window.location.hostname)
    try {
        if (domain) {
            document.cookie = [cookie, ...attributes, `Domain=${domain}`].join(
                '; ',
            )
            if (firstTouchCookiePresent()) return true
        }
        document.cookie = [cookie, ...attributes].join('; ')
        if (firstTouchCookiePresent()) return true
        throw new Error('browser did not store the first-touch cookie')
    } catch (error) {
        reportFirstTouchFailure('posthog_first_touch_cookie_write', error)
        return false
    }
}

// Per page load: `undefined` = not looked at yet, `null` = no browser.
// Avoids a storage/cookie round-trip on every identify call.
let cachedRecord: FirstTouchRecord | null | undefined

/**
 * Read the stored first-touch record, writing it from the current URL the
 * first time this browser ever loads the app. Never overwrites an existing
 * record and never throws: a blocked/full localStorage (private windows,
 * storage-partitioned iframes) or a refused cookie degrades to the other
 * store, then to an in-memory record for this page load only.
 */
export function captureFirstTouch(): FirstTouchRecord | null {
    if (cachedRecord !== undefined) return cachedRecord
    if (typeof window === 'undefined') return null

    const fromCookie = readCookieRecord()
    const fromStorage = readStoredRecord()
    const existing = fromCookie ?? fromStorage
    if (existing) {
        // Backfill whichever store lacks it (visitors from before the cookie
        // existed, or from another subdomain). Same record, never a new one.
        if (!fromCookie) writeCookieRecord(existing)
        if (!fromStorage) writeStoredRecord(existing)
        cachedRecord = existing
        return existing
    }

    const fresh = extractFirstTouch({
        search: window.location.search,
        pathname: window.location.pathname,
        referrer:
            typeof document === 'undefined' ? undefined : document.referrer,
        host: window.location.host,
    })
    writeStoredRecord(fresh)
    writeCookieRecord(fresh)

    cachedRecord = fresh
    return fresh
}
