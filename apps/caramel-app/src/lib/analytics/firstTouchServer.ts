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

// posthog-js persists `{ distinct_id, $sesid, ... }` as URL-encoded JSON in
// `ph_<project token>_posthog` (first-party cookie), which rides every
// same-site request — including the sign-up POST and the OAuth callback GET.
const posthogCookieSchema = z.object({
    distinct_id: z.string().min(1).max(200),
})

/** null = unreadable; the caller reports it (this is not a swallow). */
function distinctIdFromCookieValue(raw: string): string | null {
    try {
        const parsed = posthogCookieSchema.safeParse(
            JSON.parse(decodeURIComponent(raw)),
        )
        return parsed.success ? parsed.data.distinct_id : null
    } catch {
        return null
    }
}

/**
 * The browser's current PostHog distinct id (anonymous before signup), read
 * from its persistence cookie, or null when there is none to read. Used to
 * alias the pre-signup visits onto the new user.
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
        const distinctId = distinctIdFromCookieValue(raw)
        if (distinctId) return distinctId
        Sentry.captureMessage(
            'posthog persistence cookie present but unreadable; no alias made',
            {
                level: 'warning',
                tags: { operation: 'posthog_distinct_id_cookie_parse' },
                extra: { length: raw.length },
            },
        )
    }
    return null
}
