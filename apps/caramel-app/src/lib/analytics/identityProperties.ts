// src/lib/analytics/identityProperties.ts
//
// Pure builders for the PostHog person-property payloads ($set / $set_once).
// Deliberately imports neither posthog-js nor any browser global: identity.ts
// owns the SDK calls and reads navigator/Intl, this module only decides WHAT
// is sent. That keeps the mapping, the PII guard and the "never send an empty
// value" rule unit-testable in plain node.
//
// PII contract, enforced here: the distinct_id is ALWAYS the internal user
// UUID (it is `input.user.id`, never touched by these builders) and the email
// is a property only. `resolveDisplayName` must never fall back to the email.
import type { FirstTouchRecord } from './firstTouch'

/** Person-property values we are willing to send: scalars only. */
export type PersonProperties = Record<string, string | number | boolean>

/** The slice of the session user these builders read. */
export interface IdentityUser {
    /** Internal user UUID — this is the PostHog distinct_id. */
    id: string
    email?: string | null
    name?: string | null
    firstName?: string | null
    lastName?: string | null
    username?: string | null
    createdAt?: string | Date | null
}

/** Surface/runtime facts stamped on the person alongside the user fields. */
export interface IdentityContext {
    app_id: string
    app_version: string
    platform: string
    environment?: string
    locale?: string
    timezone?: string
}

/** The two property bags `posthog.identify` takes. */
export interface IdentityPayload {
    set: PersonProperties
    setOnce: PersonProperties
}

// Values that are technically strings but mean "we don't have this" — they
// come from template interpolation of a missing field and are worse than an
// absent property, because they look like data in a dashboard.
const PLACEHOLDER_VALUES = new Set(['undefined', 'null'])

/**
 * Drop everything we don't actually have. Nullish values, empty/whitespace
 * strings, the placeholder strings above, non-finite numbers and any
 * non-scalar are removed; surviving strings are trimmed.
 */
export function compactProperties(
    input: Record<string, unknown>,
): PersonProperties {
    const output: PersonProperties = {}

    for (const [key, value] of Object.entries(input)) {
        if (value === null || value === undefined) continue

        if (typeof value === 'string') {
            const trimmed = value.trim()
            if (!trimmed) continue
            if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) continue
            output[key] = trimmed
            continue
        }

        if (typeof value === 'number') {
            if (!Number.isFinite(value)) continue
            output[key] = value
            continue
        }

        if (typeof value === 'boolean') {
            output[key] = value
        }
        // Objects/arrays/functions are not person properties — dropped.
    }

    return output
}

/**
 * Human label for the person: full name, else first+last, else the handle.
 * NEVER the email — a display name is shown in dashboards and shared
 * screenshots, and the email is a property for the people who need it.
 */
export function resolveDisplayName(user: IdentityUser): string | undefined {
    const fullName = user.name?.trim()
    if (fullName) return fullName

    const composed = [user.firstName, user.lastName]
        .map(part => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(' ')
    if (composed) return composed

    const handle = user.username?.trim()
    if (handle) return handle

    return undefined
}

/** ISO-8601 string for a Date/date-string, or undefined if unusable. */
export function toIsoTimestamp(
    value: string | Date | null | undefined,
): string | undefined {
    if (!value) return undefined
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return undefined
    return date.toISOString()
}

/**
 * Build the `$set` / `$set_once` bags for one identify call.
 *
 * `$set` is the current truth about the person and is safe to re-send;
 * `$set_once` is the acquisition story, which PostHog keeps from the first
 * write, so a later organic session can never overwrite the campaign a user
 * originally arrived from.
 */
export function buildIdentityPayload(input: {
    user: IdentityUser
    context: IdentityContext
    firstTouch?: FirstTouchRecord | null
    /** Stable "first identify on this page load" stamp; signup_date fallback. */
    identifiedAt?: string
}): IdentityPayload {
    const { user, context, firstTouch } = input
    const createdAt = toIsoTimestamp(user.createdAt)

    const set = compactProperties({
        email: user.email,
        // `$email` is kept alongside `email` for continuity: the first
        // PostHog integration wrote only `$email` and existing cohorts and
        // dashboards still filter on it.
        $email: user.email,
        name: resolveDisplayName(user),
        // Makes the analytics <-> customer join explicit: the distinct_id IS
        // the internal user id, and nobody reading a dashboard should have to
        // know that already.
        rc_app_user_id: user.id,
        app_id: context.app_id,
        app_version: context.app_version,
        platform: context.platform,
        environment: context.environment,
        locale: context.locale,
        timezone: context.timezone,
        user_created_at: createdAt,
    })

    const setOnce = compactProperties({
        signup_date: createdAt ?? input.identifiedAt,
        first_platform: context.platform,
        first_app_version: context.app_version,
        first_utm_source: firstTouch?.utm_source,
        first_utm_medium: firstTouch?.utm_medium,
        first_utm_campaign: firstTouch?.utm_campaign,
        first_utm_term: firstTouch?.utm_term,
        first_utm_content: firstTouch?.utm_content,
        first_ref: firstTouch?.ref,
        first_gclid: firstTouch?.gclid,
        first_fbclid: firstTouch?.fbclid,
        first_referrer_domain: firstTouch?.referrer_domain,
        first_landing_path: firstTouch?.landing_path,
    })

    return { set, setOnce }
}

/**
 * Stable fingerprint of one identify call. Identity state is re-evaluated on
 * every session refresh and React commit; comparing this string lets the
 * caller skip a re-send when nothing about the person actually changed.
 */
export function identityPayloadSignature(
    distinctId: string,
    payload: IdentityPayload,
): string {
    return JSON.stringify([
        distinctId,
        sortedEntries(payload.set),
        sortedEntries(payload.setOnce),
    ])
}

/** Key-sorted entries so property insertion order cannot change the hash. */
function sortedEntries(
    properties: PersonProperties,
): [string, string | number | boolean][] {
    // `Object.entries` hands back a fresh array, so sorting in place here
    // mutates nothing the caller can observe.
    return Object.entries(properties).sort(([left], [right]) =>
        left.localeCompare(right),
    )
}
