// src/lib/analytics/codeShareFunnel.ts
//
// The checkout-code-sharing funnel diagnostics: one server-side PostHog event,
// `extension_code_share_funnel`, per step the extension reports through
// POST /api/extension/telemetry.
//
// Why: shopper code sharing went live 2026-10-10 and produced zero
// submissions, and `coupon_submit_outcome` shows nobody even reaches the
// server, so the drop is inside the extension (signed out, no sharing consent,
// the store did not visibly accept the code, the capture never armed ...).
// Those gates were console-only. This event makes each one a query.
//
// Consent-gated, anonymous by construction. The extension only sends after the
// shopper pressed Allow on a popup card (usageDiagnosticsConsent, off by
// default), and the request carries that consent as proof; the route refuses
// (403 `consent-required`) without it, exactly like POST /api/coupons/submit.
// The event carries NO code value, user id, email, URL, path or cart: the only
// free-form-looking field is the store's bare hostname. The distinct id is a
// random per-device telemetry id minted at opt-in (NOT the install id `iid`,
// never a user id), and `$process_person_profile: false` keeps PostHog from
// minting a person for it.
//
// Producer and consumer share one vocabulary. The extension is plain JS and
// cannot import this file, so apps/caramel-extension/code-share-funnel.js
// carries a copy and tests/unit/code-share-funnel-mirror.test.ts fails if the
// two ever differ (steps, reasons per step, browsers, the store and version
// patterns, and the consent floor below).
//
// Read it in PostHog: event `extension_code_share_funnel`, break down by
// `step` (and `reason` for the skip steps), filter on `ext_version`.
import {
    EXTENSION_STORES,
    EXTENSION_VERSION_PATTERN,
} from '@/lib/extensionInstall'
import { z } from 'zod'
import { captureServerEvent } from './posthogServer'

export const CODE_SHARE_FUNNEL_EVENT = 'extension_code_share_funnel'

/**
 * Step -> the reasons it may carry, in funnel order. A step with an empty list
 * carries NO reason; a step with a list MUST carry one of them.
 *
 *   capture_armed       the page's store config has the selectors capture needs
 *   apply_ignored       the shopper pressed Apply but the gesture did not qualify
 *   apply_observed      the shopper applied a code they typed (no value sent)
 *   store_accepted      the store visibly accepted that code
 *   store_not_accepted  it did not (or the evidence did not tie it to the code)
 *   prompt_shown        the sharing-consent card was shown
 *   prompt_accepted     ... "Share codes"
 *   prompt_declined     ... "No thanks"
 *   prompt_dismissed    ... the x or Esc
 *   submit_skipped      the code was not sent (background gate / server refusal)
 *   submit_sent         POST /api/coupons/submit accepted it
 */
export const CODE_SHARE_FUNNEL_STEP_REASONS = {
    capture_armed: [],
    apply_ignored: [
        'bad-code-shape',
        'not-promo-field',
        'not-typed',
        'unsafe-control',
        'already-shared',
    ],
    apply_observed: [],
    store_accepted: [],
    store_not_accepted: [
        // `not-committed` is retired: old installed builds still send it.
        'not-committed',
        'store-error',
        'not-tied-to-code',
        'price-dropped-no-row',
        'no-signal',
    ],
    prompt_shown: [],
    prompt_accepted: [],
    prompt_declined: [],
    prompt_dismissed: [],
    submit_skipped: [
        'signed-out',
        'flag-off',
        'no-consent',
        'consent-rejected',
        'daily-limit',
        'rate-limited',
        'invalid-code',
        'not-a-store',
        'refused',
        'error',
    ],
    submit_sent: [],
} as const satisfies Record<string, readonly string[]>

export type CodeShareFunnelStep = keyof typeof CODE_SHARE_FUNNEL_STEP_REASONS

export const CODE_SHARE_FUNNEL_STEPS = Object.keys(
    CODE_SHARE_FUNNEL_STEP_REASONS,
) as [CodeShareFunnelStep, ...CodeShareFunnelStep[]]

type FunnelReason =
    (typeof CODE_SHARE_FUNNEL_STEP_REASONS)[CodeShareFunnelStep][number]

/** Every reason in the vocabulary (each belongs to exactly one step; the per-step check below pins which). */
const CODE_SHARE_FUNNEL_REASONS = Object.values(
    CODE_SHARE_FUNNEL_STEP_REASONS,
).flat() as [FunnelReason, ...FunnelReason[]]

/**
 * The lowest usage-diagnostics consent prompt version whose "yes" the server
 * accepts as proof. The extension records `{ choice, at, promptVersion }`
 * locally (usage-diagnostics-consent.js) and sends `{ choice, promptVersion }`
 * with every report. Raise it ONLY when the card's meaning changes (the
 * extension then re-asks every shopper at the same time).
 * code-share-funnel-mirror.test.ts fails if this floor exceeds the version the
 * extension sends.
 */
export const MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION = 1

/** A bare lowercase hostname: no scheme, path, query, port, userinfo or whitespace. */
export const FUNNEL_STORE_PATTERN =
    /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** `crypto.randomUUID()`: the per-device telemetry id. Any UUID version, like INSTALL_ID_PATTERN. */
const TELEMETRY_ID = z.string().uuid()

/**
 * The event as the extension sends it. STRICT: an unknown key is refused, never
 * ignored, so nothing the extension adds later can ride along unreviewed.
 */
export const CodeShareFunnelEventSchema = z
    .strictObject({
        step: z.enum(CODE_SHARE_FUNNEL_STEPS),
        reason: z.enum(CODE_SHARE_FUNNEL_REASONS).optional(),
        store: z.string().regex(FUNNEL_STORE_PATTERN),
        extVersion: z.string().regex(EXTENSION_VERSION_PATTERN),
        browser: z.enum(EXTENSION_STORES),
        sharingPromptVersion: z.number().int().min(1).max(1000),
    })
    .superRefine((event, ctx) => {
        const allowed: readonly string[] =
            CODE_SHARE_FUNNEL_STEP_REASONS[event.step]
        if (allowed.length === 0) {
            if (event.reason !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['reason'],
                    message: `step ${event.step} takes no reason`,
                })
            }
            return
        }
        if (event.reason === undefined || !allowed.includes(event.reason)) {
            ctx.addIssue({
                code: 'custom',
                path: ['reason'],
                message: `step ${event.step} needs a reason of ${allowed.join(', ')}`,
            })
        }
    })

export type CodeShareFunnelEvent = z.infer<typeof CodeShareFunnelEventSchema>

/**
 * What the extension sends (background.js reportCodeShareFunnel): the event,
 * its telemetry id, and the consent proof. `consent` is deliberately `unknown`
 * here: a missing, declined or old proof must answer 403 `consent-required`
 * (below), not the generic 422 body-schema error.
 */
export const ExtensionTelemetryBodySchema = z.strictObject({
    id: TELEMETRY_ID,
    event: CodeShareFunnelEventSchema,
    consent: z.unknown().optional(),
})

/** The proof itself: `accepted`, at or above the server's floor; strict. */
export const UsageDiagnosticsConsentProofSchema = z.strictObject({
    choice: z.literal('accepted'),
    promptVersion: z
        .number()
        .int()
        .min(MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION),
})

/** The route's reply; the extension checks `captured` and logs when it is false. */
export interface ExtensionTelemetryResponse {
    /** PostHog accepted the event (false: capture disabled for this dataset, or the send failed and is in Sentry). */
    captured: boolean
}

/**
 * Capture one funnel step. Resolves true when PostHog accepted it. Never
 * throws (captureServerEvent reports failures to Sentry and returns false),
 * so the route can pass the boolean on.
 *
 * The properties are an allowlist written out field by field, NOT a spread of
 * the input: a field the schema gains later has to be added here on purpose.
 */
export async function recordCodeShareFunnel(args: {
    telemetryId: string
    event: CodeShareFunnelEvent
}): Promise<boolean> {
    const { event } = args
    return captureServerEvent({
        event: CODE_SHARE_FUNNEL_EVENT,
        distinctId: args.telemetryId,
        properties: {
            step: event.step,
            ...(event.reason ? { reason: event.reason } : {}),
            store: event.store,
            ext_version: event.extVersion,
            browser: event.browser,
            sharing_prompt_version: event.sharingPromptVersion,
            $process_person_profile: false,
        },
    })
}
