import {
    ExtensionTelemetryBodySchema,
    UsageDiagnosticsConsentProofSchema,
    recordCodeShareFunnel,
    type ExtensionTelemetryResponse,
} from '@/lib/analytics/codeShareFunnel'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { NextResponse } from 'next/server'

// POST /api/extension/telemetry — the extension's opt-in, anonymous report of
// where the checkout code-sharing offer stops (one body = one funnel step).
// The vocabulary, the strict schema and the PostHog event live in
// src/lib/analytics/codeShareFunnel.ts; this file is the gate.
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
//   - NO auth, on purpose: this is anonymous. The extension sends no bearer and
//     no cookies, and the handler never reads a session, so nothing here can
//     be joined to an account. The telemetry id is a random per-device id,
//     not the install id (`iid`) and not a user id.
//
// Consent proof (same pattern as POST /api/coupons/submit): the body must carry
// consent = { choice: 'accepted', promptVersion >= the floor }, exactly the
// record the extension stored when the shopper pressed Allow. Missing,
// declined or old proof -> 403 `consent-required` and NOTHING is emitted. Honest
// limit: a client-asserted claim, not cryptographic proof; it refuses every
// build that does not know about the consent and makes the claim auditable.
//
// Check order: origin (403) + rate limit (429) + body schema (422), all in
// withRoute -> consent proof (403 `consent-required`) -> emit. The reply is
// `{ captured }` and the extension checks it; a false is never swallowed (the
// extension logs it), and the PostHog failure behind it is already in Sentry.
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
        if (
            !UsageDiagnosticsConsentProofSchema.safeParse(body.consent).success
        ) {
            // An anticipated refusal, not an incident: no Sentry noise, and
            // nothing about the rejected payload is logged.
            return NextResponse.json(
                { error: 'consent-required' },
                { status: 403, headers: NO_STORE },
            )
        }

        const captured = await recordCodeShareFunnel({
            telemetryId: body.id,
            event: body.event,
        })
        if (!captured) {
            console.warn(
                '[extension-telemetry] funnel event not captured (PostHog capture disabled or failed)',
                { step: body.event.step },
            )
        }
        const response: ExtensionTelemetryResponse = { captured }
        return NextResponse.json(response, { headers: NO_STORE })
    },
)
