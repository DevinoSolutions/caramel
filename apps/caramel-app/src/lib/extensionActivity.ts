// src/lib/extensionActivity.ts
//
// The ONE contract for the Google Chrome extension's daily-active-installation
// ping: POST /api/extension/activity → PostHog `extension_active`.
//
// What it measures: DAU = the number of UNIQUE `dailyId`s per UTC `day`. The
// extension sends at most one successful ping per installation per UTC day,
// triggered only by the user opening the popup (guests included). `dailyId` is
// SHA-256(ID_DOMAIN \0 seed \0 day) over a random per-install seed that never
// leaves the browser, so ids rotate at UTC midnight and two days of one
// installation cannot be linked — which also means this cannot measure
// retention, and one person with two installs counts twice.
//
// Producer (apps/caramel-extension/extension-activity.js) and consumer (the
// route) share these values through the generated
// apps/caramel-extension/coupon-constants.generated.js (`CaramelExtensionActivity`,
// rendered by scripts/generate-coupon-constants.ts and byte-pinned by
// tests/unit/coupon-constants.generated.test.ts) — never a hand-copied twin.
import { z } from 'zod'

export const EXTENSION_ACTIVITY_EVENT = 'extension_active' as const

/** Route path, relative to the deployment base URL (the extension resolves it
 * against its build-time CARAMEL_ENV.baseUrl). */
export const EXTENSION_ACTIVITY_PATH = 'api/extension/activity' as const

/** Domain separator hashed in front of the seed, so this digest can never
 * collide with any other use of the same seed (and a future v2 rotates every
 * id at once). */
export const EXTENSION_ACTIVITY_ID_DOMAIN = 'caramel-ext-dau-v1' as const

/** The only browser this ping is sent from (see extension-activity.js for the
 * runtime detection and its limits). */
export const EXTENSION_ACTIVITY_BROWSER = 'chrome' as const

/** Route answers. Only `recorded` means PostHog accepted the capture; the
 * extension persists the day on that value ALONE. */
export const EXTENSION_ACTIVITY_STATUS = {
    RECORDED: 'recorded',
    DISABLED: 'disabled',
    CAPTURE_FAILED: 'capture_failed',
} as const

const DAY_MS = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` of the UTC calendar day containing `ms`. */
export function utcDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10)
}

/**
 * A client day is accepted when it is the server's UTC day or one either side
 * of it — a popup opened seconds before midnight lands after it, and a client
 * clock a little ahead names tomorrow. Anything further out is a broken clock
 * or a replay, and is refused (422) rather than counted against the wrong day.
 */
export function isAcceptedActivityDay(day: string, nowMs: number): boolean {
    return (
        day === utcDay(nowMs) ||
        day === utcDay(nowMs - DAY_MS) ||
        day === utcDay(nowMs + DAY_MS)
    )
}

export const ExtensionActivityBodySchema = z
    .object({
        // 64 lowercase hex chars — a SHA-256 digest, nothing else fits.
        dailyId: z.string().regex(/^[0-9a-f]{64}$/),
        day: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .refine(d => utcDay(Date.parse(`${d}T00:00:00Z`) || 0) === d),
        // manifest.json version grammar: 1–4 dot-separated integers.
        extensionVersion: z.string().regex(/^\d{1,9}(\.\d{1,9}){0,3}$/),
        browser: z.literal(EXTENSION_ACTIVITY_BROWSER),
    })
    // Exactly these fields: in particular a client-sent `signed_in` (the
    // server derives it from the session) or anything identifying is refused
    // outright rather than silently dropped.
    .strict()

/**
 * Deterministic event UUID for one installation-day: the first 128 bits of
 * the dailyId, shaped as an RFC 9562 v8 (custom) UUID. Re-sending the same day
 * after a lost response therefore carries the SAME uuid. dailyId is already a
 * one-way digest, so this reveals nothing the distinct_id doesn't.
 */
export function extensionActivityEventUuid(dailyId: string): string {
    const h = dailyId.slice(0, 32).split('')
    h[12] = '8' // version 8
    h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) // RFC variant
    const s = h.join('')
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
