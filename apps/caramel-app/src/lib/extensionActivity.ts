// src/lib/extensionActivity.ts
//
// The ONE contract for the extension's popup-open daily-active event: a
// `{ kind: 'daily_active' }` body on the existing opt-in diagnostics route
// (POST /api/extension/telemetry) → PostHog `extension_active`.
//
// What it measures: OPTED-IN daily active Google Chrome installations — the
// number of unique diagnostics ids per UTC `day`. It is NOT total DAU: the
// extension sends it only after the shopper accepted pseudonymous usage
// diagnostics (usage-diagnostics-consent.js), only from Google Chrome, only
// when the server's EXTENSION_DAU_TELEMETRY_ENABLED flag (served by
// GET /api/extension/features) is on, and at most once per UTC day, triggered
// only by opening the popup. Guests and signed-in shoppers send the identical
// body: no bearer, no cookies, no account state.
//
// Identity: the existing per-device diagnostics id (`caramel_usage_diagnostics_id`,
// minted only on the explicit accept path, deleted on withdrawal) — the same
// distinct id the code-share funnel uses, so there is no second per-install id.
//
// Advisory, not abuse-proof: the extension Origin and the consent proof are
// client-asserted, not cryptographic. What bounds a forger is the strict
// schema, the route's isolated `telemetry` rate limit and the deterministic
// event uuid below (a retry of the same id+day is the same event). Read the
// numbers as directional (RUNBOOK "Extension DAU telemetry").
//
// Producer: apps/caramel-extension/extension-activity.js buildDailyActiveEvent;
// tests/unit/code-share-funnel-mirror.test.ts parses its output with the
// schema below, so producer and consumer cannot drift.
import { WORKED_AT_CLOCK_SKEW_TOLERANCE_MS } from '@/lib/coupons'
import { EXTENSION_VERSION_PATTERN } from '@/lib/extensionInstall'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { captureServerEvent } from './analytics/posthogServer'

export const EXTENSION_ACTIVE_EVENT = 'extension_active'

/**
 * The lowest usage-diagnostics consent prompt version whose "yes" covers this
 * event: version 2 is the first card that names it (a v1 yes was given to
 * checkout diagnostics only). Stricter than the route's general floor
 * (MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION), which old builds' funnel
 * events still meet. code-share-funnel-mirror.test.ts fails if it exceeds the
 * version the extension sends.
 */
export const MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION = 2

/** `YYYY-MM-DD` of the UTC calendar day containing `ms`. */
export function utcDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10)
}

/**
 * A client day is accepted only when it is the server's UTC day as seen from
 * within the shared clock-skew tolerance (WORKED_AT_CLOCK_SKEW_TOLERANCE_MS,
 * 5 minutes): a popup opened seconds before midnight may land after it, and a
 * clock a few minutes ahead may name tomorrow just before midnight. Anything
 * further out is a broken clock or a replay and is refused (422), never
 * counted against the wrong day.
 */
export function isAcceptedActivityDay(day: string, nowMs: number): boolean {
    return (
        day === utcDay(nowMs) ||
        day === utcDay(nowMs - WORKED_AT_CLOCK_SKEW_TOLERANCE_MS) ||
        day === utcDay(nowMs + WORKED_AT_CLOCK_SKEW_TOLERANCE_MS)
    )
}

/**
 * The daily-active variant of the telemetry event. STRICT and exactly these
 * reviewed fields: an unknown or identifying key (a user id, `signed_in`, a
 * URL ...) is refused, never dropped. `kind` is what tells it apart from a
 * code-share funnel event, which has no `kind` (so every shipped funnel
 * payload keeps validating unchanged).
 */
export const DailyActiveEventSchema = z.strictObject({
    kind: z.literal('daily_active'),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    extVersion: z.string().regex(EXTENSION_VERSION_PATTERN),
    browser: z.literal('chrome'),
})

export type DailyActiveEvent = z.infer<typeof DailyActiveEventSchema>

/**
 * Deterministic event UUID for one diagnostics-id-day: SHA-256 of a domain
 * separator, the id and the day, shaped as an RFC 9562 v8 (custom) UUID.
 * A resend after a lost response carries the SAME uuid, so PostHog can
 * collapse it. The id is already random, so this reveals nothing the
 * distinct id doesn't.
 */
export function dailyActiveEventUuid(telemetryId: string, day: string): string {
    const h = createHash('sha256')
        .update(`caramel-ext-active-v1\0${telemetryId}\0${day}`)
        .digest('hex')
        .slice(0, 32)
        .split('')
    h[12] = '8' // version 8
    h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) // RFC variant
    const s = h.join('')
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/**
 * Capture one daily-active event. Resolves true when PostHog accepted it;
 * never throws (captureServerEvent reports failures to Sentry). Properties are
 * an allowlist written field by field, never a spread of the input.
 */
export function recordExtensionDailyActive(args: {
    telemetryId: string
    event: DailyActiveEvent
}): Promise<boolean> {
    const { telemetryId, event } = args
    return captureServerEvent({
        event: EXTENSION_ACTIVE_EVENT,
        distinctId: telemetryId,
        uuid: dailyActiveEventUuid(telemetryId, event.day),
        properties: {
            day: event.day,
            ext_version: event.extVersion,
            browser: event.browser,
            // Overrides captureServerEvent's 'web' stamp: this event is about
            // the extension, not the website.
            platform: 'extension',
            activity_trigger: 'popup_open',
            // Event-only: no person profile for the diagnostics id.
            $process_person_profile: false,
            // posthog-node already defaults disableGeoip to true; stated here
            // so a client-option change cannot start enriching it.
            $geoip_disable: true,
        },
    })
}
