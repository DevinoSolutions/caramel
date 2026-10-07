'use client'
// src/lib/feedback/reportUserVisibleFailure.ts
//
// Standard client-side "a user-visible operation failed" reporter for the
// feedback+observability flow. Always reports the error to Sentry (keeping
// THAT capture's event id, never a global last-event id), and — the first
// time a given operation+errorCode fingerprint fails in a browser session —
// captures a `user_visible_operation_failed` PostHog event carrying the Sentry
// event id for cross-linking. Rate-limited per fingerprint per session so a
// caller knows whether to surface a feedback prompt. Never throws.
import { capturePosthog } from '@/lib/analytics/posthogBrowser'
import { APP_ID } from '@/lib/analytics/posthogDataset'
import { APP_VERSION } from '@/lib/env.client'
import * as Sentry from '@sentry/nextjs'

const SESSION_KEY_PREFIX = 'caramel:uvf:'

/** Has this fingerprint already fired this browser session? Never throws. */
function alreadyReported(fingerprint: string): boolean {
    try {
        if (typeof sessionStorage === 'undefined') return false
        return sessionStorage.getItem(SESSION_KEY_PREFIX + fingerprint) !== null
    } catch {
        return false
    }
}

function markReported(fingerprint: string): void {
    try {
        if (typeof sessionStorage === 'undefined') return
        sessionStorage.setItem(SESSION_KEY_PREFIX + fingerprint, '1')
    } catch {
        // sessionStorage unavailable (privacy mode / SSR) — best-effort only.
    }
}

export function reportUserVisibleFailure(input: {
    error: unknown
    operation: string
    errorCode?: string
    extra?: Record<string, unknown>
}): { sentryEventId: string | null; rateLimited: boolean } {
    // Sentry ALWAYS receives the error — keep this call's own event id.
    const sentryEventId =
        Sentry.captureException(input.error, {
            tags: { operation: input.operation },
        }) ?? null

    const fingerprint = `${input.operation}::${input.errorCode ?? 'none'}`
    const rateLimited = alreadyReported(fingerprint)

    if (!rateLimited) {
        markReported(fingerprint)
        // Properties (the route especially) and the timestamp are taken NOW:
        // the capture may be replayed a moment later, once posthog-js loads.
        const properties = {
            sentry_event_id: sentryEventId,
            operation: input.operation,
            error_code: input.errorCode ?? null,
            app_id: APP_ID,
            app_version: APP_VERSION,
            route:
                typeof window !== 'undefined' ? window.location.pathname : null,
            ...input.extra,
        }
        capturePosthog('user_visible_operation_failed', properties, error =>
            console.error(
                '[feedback] user_visible_operation_failed capture failed',
                error,
            ),
        )
    }

    return { sentryEventId, rateLimited }
}
