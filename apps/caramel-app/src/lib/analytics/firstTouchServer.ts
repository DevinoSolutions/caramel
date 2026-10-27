// src/lib/analytics/firstTouchServer.ts
//
// The SERVER half of first-touch capture: read what the browser wrote
// (firstTouch.ts -> `cm_ft` cookie) and the browser's anonymous PostHog id
// from the incoming request, so signup and install events can be attributed
// even when the visitor's own PostHog traffic never arrived (ad blocker,
// consent refusal, failed load).
//
// The record is validated with the SAME schema the browser writes it with
// (firstTouchRecord.ts). Anything invalid is treated as absent — but loudly:
// a malformed cookie means either a client/server schema drift or someone
// tampering, and both deserve a Sentry warning rather than a silent shrug.
import * as Sentry from '@sentry/nextjs'
import 'server-only'
import { z } from 'zod'
import { readCookieValues } from './cookieHeader'
import {
    FIRST_TOUCH_COOKIE_NAME,
    parseFirstTouchCookieValue,
    type FirstTouchRecord,
} from './firstTouchRecord'

/** The only part of `Headers`/`NextRequest['headers']` these readers need. */
export interface HeaderReader {
    get(name: string): string | null
}

/**
 * The first-touch record from the request's `cm_ft` cookie, or null when the
 * cookie is absent or invalid (invalid additionally reports to Sentry).
 */
export function readFirstTouchFromHeaders(
    headers: HeaderReader | null | undefined,
): FirstTouchRecord | null {
    const values = readCookieValues(
        headers?.get('cookie'),
        FIRST_TOUCH_COOKIE_NAME,
    )
    for (const raw of values) {
        const parsed = parseFirstTouchCookieValue(raw)
        if (parsed.ok) return parsed.record
        Sentry.captureMessage(
            'first-touch cookie present but invalid; treated as absent',
            {
                level: 'warning',
                tags: { operation: 'first_touch_cookie_parse' },
                extra: { reason: parsed.reason, length: raw.length },
            },
        )
    }
    return null
}

// posthog-js (1.438.x, default `localStorage+cookie` persistence, which is what
// identity.ts configures) mirrors its COOKIE_PERSISTED_PROPERTIES into the
// first-party cookie `ph_<project token>_posthog` as
// `encodeURIComponent(JSON.stringify({ distinct_id, $device_id, $sesid,
// $epp, $initial_person_info, $user_state, ... }))` — single-encoded, so one
// decodeURIComponent + JSON.parse reads it. The cookie rides every same-site
// request, including the sign-up POST and the OAuth callback GET. Anonymous
// and identified visitors share the shape; only `distinct_id` and
// `$user_state` differ. A sibling `ph_<token>_posthog_cpm` sidecar cookie
// exists but never matches this exact name.
const posthogCookieSchema = z.object({
    distinct_id: z.string().min(1).max(200),
})

// posthog-js's in-memory-only id in cookieless mode: one shared value for every
// visitor, so it is never an identity to alias.
const POSTHOG_COOKIELESS_SENTINEL_DISTINCT_ID = '$posthog_cookieless'

/** Cap on key names echoed to Sentry: names come from a client-controlled cookie. */
const MAX_REPORTED_COOKIE_KEYS = 20
const MAX_REPORTED_COOKIE_KEY_LENGTH = 40

/**
 * Why a persistence cookie yielded no distinct id. The `absent_*` reasons are
 * the documented no-id states (nothing to alias, nothing to report); every
 * other reason is a failure that gets a Sentry warning.
 */
type PosthogCookieReadReason =
    | 'decode_error'
    | 'json_error'
    | 'not_object'
    | 'distinct_id_missing'
    | 'distinct_id_not_string'
    | 'distinct_id_empty'
    | 'distinct_id_too_long'
    | 'absent_empty_object'
    | 'absent_cookieless_sentinel'

type PosthogCookieRead =
    | { ok: true; distinctId: string }
    | {
          ok: false
          reason: PosthogCookieReadReason
          /** JSON type of the decoded value, set for `not_object`. */
          valueType?: string
          /** Top-level key NAMES only (never values), set once an object was parsed. */
          keys?: string[]
      }

function jsonValueType(value: unknown): string {
    if (value === null) return 'null'
    return Array.isArray(value) ? 'array' : typeof value
}

function readPosthogCookieValue(raw: string): PosthogCookieRead {
    let decoded: string
    try {
        decoded = decodeURIComponent(raw)
    } catch {
        return { ok: false, reason: 'decode_error' }
    }
    let parsedJson: unknown
    try {
        parsedJson = JSON.parse(decoded)
    } catch {
        return { ok: false, reason: 'json_error' }
    }
    if (
        parsedJson === null ||
        typeof parsedJson !== 'object' ||
        Array.isArray(parsedJson)
    ) {
        return {
            ok: false,
            reason: 'not_object',
            valueType: jsonValueType(parsedJson),
        }
    }
    const cookie = parsedJson as Record<string, unknown>
    const keys = Object.keys(cookie)
        .slice(0, MAX_REPORTED_COOKIE_KEYS)
        .map(key => key.slice(0, MAX_REPORTED_COOKIE_KEY_LENGTH))
    // posthog-js never writes an empty snapshot (it skips the cookie when no
    // persisted property has a value), but an empty object is what a cleared
    // persistence looks like: no visitor id exists, so there is nothing to alias.
    if (keys.length === 0) {
        return { ok: false, reason: 'absent_empty_object', keys }
    }
    if (!('distinct_id' in cookie)) {
        return { ok: false, reason: 'distinct_id_missing', keys }
    }
    const distinctId: unknown = cookie.distinct_id
    if (distinctId === POSTHOG_COOKIELESS_SENTINEL_DISTINCT_ID) {
        return { ok: false, reason: 'absent_cookieless_sentinel', keys }
    }
    if (typeof distinctId !== 'string') {
        return { ok: false, reason: 'distinct_id_not_string', keys }
    }
    if (distinctId.length === 0) {
        return { ok: false, reason: 'distinct_id_empty', keys }
    }
    const checked = posthogCookieSchema.safeParse(cookie)
    if (!checked.success) {
        return { ok: false, reason: 'distinct_id_too_long', keys }
    }
    return { ok: true, distinctId: checked.data.distinct_id }
}

/**
 * The browser's current PostHog distinct id (anonymous before signup), read
 * from its persistence cookie, or null when there is none to read. Used to
 * alias the pre-signup visits onto the new user. An unreadable cookie is
 * reported to Sentry with the reason (never the cookie value or the id); the
 * documented no-id states return null quietly.
 */
export function readPosthogDistinctId(
    headers: HeaderReader | null | undefined,
    projectToken: string,
): string | null {
    const values = readCookieValues(
        headers?.get('cookie'),
        `ph_${projectToken}_posthog`,
    )
    for (const raw of values) {
        const read = readPosthogCookieValue(raw)
        if (read.ok) return read.distinctId
        if (read.reason.startsWith('absent_')) continue
        Sentry.captureMessage(
            'posthog persistence cookie present but unreadable; no alias made',
            {
                level: 'warning',
                tags: { operation: 'posthog_distinct_id_cookie_parse' },
                extra: {
                    reason: read.reason,
                    length: raw.length,
                    ...(read.valueType ? { valueType: read.valueType } : {}),
                    ...(read.keys ? { topLevelKeys: read.keys } : {}),
                },
            },
        )
    }
    return null
}
