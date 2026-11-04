import {
    ExtensionTelemetryBodySchema,
    UsageDiagnosticsConsentProofSchema,
    recordCodeShareFunnel,
    type ExtensionTelemetryResponse,
} from '@/lib/analytics/codeShareFunnel'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { env } from '@/lib/env'
import {
    MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION,
    isAcceptedActivityDay,
    recordExtensionDailyActive,
} from '@/lib/extensionActivity'
import { NextResponse } from 'next/server'

// POST /api/extension/telemetry — the extension's opt-in, pseudonymous usage
// diagnostics. One body = one event, of two kinds:
//   - a code-share funnel step (where the checkout code-sharing offer stops;
//     no `kind`, src/lib/analytics/codeShareFunnel.ts);
//   - `kind: 'daily_active'`, the Google Chrome popup-open daily-active event
//     (src/lib/extensionActivity.ts).
// The vocabularies, the strict schemas and the PostHog events live in those
// modules; this file is the gate.
//
// withRoute options, mirroring extension/coupon-box-pick:
//   - origin: 'extension' — the Origin must be present AND a browser-extension
//     protocol. This only stops browsers (any HTTP client can forge the
//     header); the real bounds are the consent proof below, the strict body
//     schema (a request can only say what the vocabulary allows) and the
//     'telemetry' rate limit: its OWN bucket (60/min per ip+route) that is
//     exempt from the shared burst limiter and cannot spend the 'mutation'
//     budget, so diagnostics traffic can never 429 a shopper's code submission.
//   - cors: 'extension' + the OPTIONS preflight, so a preflighted
//     extension-origin fetch can read the answer.
//   - NO auth, on purpose: this is pseudonymous, not anonymous. The extension
//     sends no bearer and no cookies, and the handler never reads a session, so
//     this route never attaches an account to an event. The telemetry id is a
//     random per-device id, not the install id (`iid`) and not a user id; it
//     still singles out one device, and IP and user agent reach the logs.
//
// Consent proof (same pattern as POST /api/coupons/submit): the body must carry
// consent = { choice: 'accepted', promptVersion >= the floor }, exactly the
// record the extension stored when the shopper pressed Allow. Missing,
// declined or old proof -> 403 `consent-required` and NOTHING is emitted; a
// daily_active event needs a proof at or above its own, higher floor
// (MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION: the first card that named it). Honest
// limit: a client-asserted claim, not cryptographic proof; it refuses every
// build that does not know about the consent and makes the claim auditable.
//
// Check order: origin (403) + rate limit (429) + body schema (422), all in
// withRoute -> consent proof (403 `consent-required`) -> per kind:
//   daily_active: day within the clock-skew policy (else 422) ->
//     EXTENSION_DAU_TELEMETRY_ENABLED (off: `{ captured: false }`, nothing
//     emitted — defence in depth behind the extension's own read of the same
//     flag from /api/extension/features) -> emit.
//   funnel step: emit (the DAU flag never touches it).
// The reply is `{ captured }` and the extension checks it; a false is never
// swallowed (the extension logs it), and the PostHog failure behind it is
// already in Sentry.
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/telemetry',
        rateLimit: 'telemetry',
        cors: 'extension',
        origin: 'extension',
        body: ExtensionTelemetryBodySchema,
    },
    async ({ body }) => {
        const { event } = body
        const proof = UsageDiagnosticsConsentProofSchema.safeParse(body.consent)
        if (
            !proof.success ||
            // Daily activity needs a yes given on a card that named it.
            ('kind' in event &&
                proof.data.promptVersion <
                    MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION)
        ) {
            // An anticipated refusal, not an incident: no Sentry noise, and
            // nothing about the rejected payload is logged.
            return NextResponse.json(
                { error: 'consent-required' },
                { status: 403, headers: NO_STORE },
            )
        }

        let captured: boolean
        if ('kind' in event) {
            if (!isAcceptedActivityDay(event.day, Date.now())) {
                return NextResponse.json(
                    { error: 'Invalid request body' },
                    { status: 422, headers: NO_STORE },
                )
            }
            if (!env.EXTENSION_DAU_TELEMETRY_ENABLED) {
                const off: ExtensionTelemetryResponse = { captured: false }
                return NextResponse.json(off, { headers: NO_STORE })
            }
            captured = await recordExtensionDailyActive({
                telemetryId: body.id,
                event,
            })
        } else {
            captured = await recordCodeShareFunnel({
                telemetryId: body.id,
                event,
            })
        }
        if (!captured) {
            console.warn(
                '[extension-telemetry] event not captured (PostHog capture disabled or failed)',
                'kind' in event ? { kind: event.kind } : { step: event.step },
            )
        }
        const response: ExtensionTelemetryResponse = { captured }
        return NextResponse.json(response, { headers: NO_STORE })
    },
)
