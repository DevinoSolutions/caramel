import {
    captureServerEvent,
    isServerCaptureConfigured,
} from '@/lib/analytics/posthogServer'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { env } from '@/lib/env'
import {
    EXTENSION_ACTIVITY_EVENT,
    EXTENSION_ACTIVITY_STATUS,
    ExtensionActivityBodySchema,
    extensionActivityEventUuid,
    isAcceptedActivityDay,
} from '@/lib/extensionActivity'
import { NextResponse } from 'next/server'

// POST /api/extension/activity — the Google Chrome extension's once-per-UTC-day
// "this installation was used" ping, sent by the background worker when the
// user opens the popup. Contract + privacy model: src/lib/extensionActivity.ts.
//
// withRoute:
//   - origin 'extension' (strict extension-protocol Origin, no missing-Origin
//     bypass) + cors 'extension': only the extension itself can call this.
//   - auth 'optional': guests are the common case. A valid bearer only flips
//     `signed_in`; an invalid/expired one resolves to `session: null` and the
//     installation is counted as a guest, never refused. Nothing about the
//     session (id, email, token) reaches PostHog.
//   - rateLimit 'mutation': one legitimate call per install per day.
//   - body: the strict shared schema (extra fields → 422).
//
// Answers (the extension persists the day ONLY on `recorded`):
//   200 { status: 'recorded' }       PostHog accepted the capture
//   200 { status: 'disabled' }       kill switch off, or this deploy's
//                                    POSTHOG_DATASET is disabled/unconfigured
//   502 { status: 'capture_failed' } capture failed (captureServerEvent has
//                                    already reported it to Sentry)
//   422                              body/day refused
export const dynamic = 'force-dynamic'

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/activity',
        cors: 'extension',
        origin: 'extension',
        rateLimit: 'mutation',
        auth: 'optional',
        body: ExtensionActivityBodySchema,
    },
    async ({ body, session }) => {
        if (!isAcceptedActivityDay(body.day, Date.now())) {
            return NextResponse.json(
                { error: 'Invalid request body' },
                { status: 422 },
            )
        }

        if (
            !env.EXTENSION_DAU_TELEMETRY_ENABLED ||
            !isServerCaptureConfigured()
        ) {
            return NextResponse.json({
                status: EXTENSION_ACTIVITY_STATUS.DISABLED,
            })
        }

        const captured = await captureServerEvent({
            event: EXTENSION_ACTIVITY_EVENT,
            // The rotating daily id IS the distinct id: never identify(), never
            // alias, never the account id — see the contract module.
            distinctId: body.dailyId,
            uuid: extensionActivityEventUuid(body.dailyId),
            properties: {
                day: body.day,
                extension_version: body.extensionVersion,
                browser: body.browser,
                signed_in: session !== null,
                // Overrides captureServerEvent's 'web' stamp: this event is
                // about the extension, not the website.
                platform: 'extension',
                activity_trigger: 'popup_open',
                // An event-only capture: no person profile is created or
                // updated for the throwaway daily id (posthog-node 5.46 lifts
                // this sentinel into the capture's process_person_profile).
                $process_person_profile: false,
                // posthog-node already defaults disableGeoip to true; stated
                // here so a client-option change cannot start enriching it.
                $geoip_disable: true,
            },
        })

        if (!captured) {
            return NextResponse.json(
                { status: EXTENSION_ACTIVITY_STATUS.CAPTURE_FAILED },
                { status: 502 },
            )
        }
        return NextResponse.json({ status: EXTENSION_ACTIVITY_STATUS.RECORDED })
    },
)
