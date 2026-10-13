// src/lib/analytics/firstTouchRecord.ts
//
// The ONE definition of a first-touch record, shared by its producer (the
// browser, firstTouch.ts) and its consumers (the signup hook, /api/ext/installed
// and the welcome page, via firstTouchServer.ts). Producer and consumer import
// this schema, so a field added on one side that the other would silently drop
// fails the type-check instead of failing in production attribution reports.
//
// Isomorphic and dependency-light on purpose (`zod/mini`, same as
// env.client.ts, the other zod importer the browser bundle already carries):
// no Sentry, no window, no server-only. Anything that needs those lives in the
// two modules that import this one.
import * as z from 'zod/mini'

/** First-party cookie carrying the record (read by the server at signup). */
export const FIRST_TOUCH_COOKIE_NAME = 'cm_ft'

/** 90 days: long enough to bridge "saw the ad" to "got round to signing up". */
export const FIRST_TOUCH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90

/** Browsers cap one cookie at ~4096 bytes of name+value. Stay well under. */
const COOKIE_VALUE_MAX_CHARS = 3500

/** Attribution values are labels, not payloads: a cap keeps junk bounded. */
export const FIRST_TOUCH_MAX_VALUE_LENGTH = 255

/** Query params we treat as attribution, in the order they are read. */
export const FIRST_TOUCH_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'ref',
    // Ad-platform click ids. Kept (not just their presence) because an
    // offline-conversion upload needs the value itself.
    'gclid',
    'gbraid',
    'wbraid',
    'fbclid',
    'msclkid',
    'ttclid',
] as const

const label = z.optional(
    z.string().check(z.maxLength(FIRST_TOUCH_MAX_VALUE_LENGTH)),
)

/** The persisted record. Everything except `captured_at` is best-effort. */
export const firstTouchRecordSchema = z.object({
    utm_source: label,
    utm_medium: label,
    utm_campaign: label,
    utm_term: label,
    utm_content: label,
    ref: label,
    gclid: label,
    gbraid: label,
    wbraid: label,
    fbclid: label,
    msclkid: label,
    ttclid: label,
    referrer_domain: label,
    landing_path: label,
    captured_at: z.string().check(z.minLength(1), z.maxLength(64)),
})

export type FirstTouchRecord = z.infer<typeof firstTouchRecordSchema>

export type FirstTouchParseResult =
    | { ok: true; record: FirstTouchRecord }
    | { ok: false; reason: string }

/** Validate an already-JSON-parsed value. Unknown keys are dropped. */
export function parseFirstTouchRecord(value: unknown): FirstTouchParseResult {
    const result = firstTouchRecordSchema.safeParse(value)
    if (result.success) return { ok: true, record: result.data }
    return {
        ok: false,
        reason: result.error.issues
            .map(
                issue =>
                    `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            )
            .join('; '),
    }
}

/**
 * Parse the raw (URL-encoded JSON) `cm_ft` cookie value. Never throws; the
 * caller decides how loudly to report a `{ ok: false }`.
 */
export function parseFirstTouchCookieValue(raw: string): FirstTouchParseResult {
    let json: unknown
    try {
        json = JSON.parse(decodeURIComponent(raw))
    } catch (error) {
        return {
            ok: false,
            reason: `not URL-encoded JSON (${error instanceof Error ? error.message : String(error)})`,
        }
    }
    return parseFirstTouchRecord(json)
}

// Fields dropped first when the encoded record would overflow the cookie
// limit: least valuable for attribution first, `captured_at` and the source
// fields never.
const COOKIE_SHED_ORDER: readonly (keyof FirstTouchRecord)[] = [
    'utm_term',
    'utm_content',
    'landing_path',
    'ttclid',
    'msclkid',
    'wbraid',
    'gbraid',
    'fbclid',
    'gclid',
]

/**
 * URL-encoded JSON for the cookie. The record is bounded per value (255) but
 * not in total, so a pathological landing URL could overflow the 4 KB cookie
 * limit and make the browser drop the cookie entirely; shed low-value fields
 * until it fits rather than lose the whole record.
 */
export function serializeFirstTouchCookieValue(
    record: FirstTouchRecord,
): string {
    const trimmed: FirstTouchRecord = { ...record }
    let encoded = encodeURIComponent(JSON.stringify(trimmed))
    for (const field of COOKIE_SHED_ORDER) {
        if (encoded.length <= COOKIE_VALUE_MAX_CHARS) break
        delete trimmed[field]
        encoded = encodeURIComponent(JSON.stringify(trimmed))
    }
    return encoded
}

/**
 * The human-meaningful acquisition source of a record, or `null` when the
 * record carries no signal at all (an organic/direct landing). Order: an
 * explicit tag the marketer set (utm_source, ref) beats an inferred one (ad
 * click id), which beats the bare referrer host.
 */
export function deriveFirstTouchSource(
    record: FirstTouchRecord | null | undefined,
): string | null {
    if (!record) return null
    if (record.utm_source) return record.utm_source
    if (record.ref) return record.ref
    if (record.gclid || record.gbraid || record.wbraid) return 'google_ads'
    if (record.msclkid) return 'bing_ads'
    if (record.fbclid) return 'meta'
    if (record.ttclid) return 'tiktok'
    if (record.referrer_domain) return record.referrer_domain
    return null
}
