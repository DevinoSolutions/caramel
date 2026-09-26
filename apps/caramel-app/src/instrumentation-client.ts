import * as Sentry from '@sentry/nextjs'

// Next.js only loads client instrumentation from `instrumentation-client.ts`.
// This file was named `instrumentation.client.ts` until 2026-09-26, so the
// browser SDK never started: 0 browser events in 90 days of Sentry, and no
// client-side report (error boundary, captureMessage) ever arrived.

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (process.env.NODE_ENV === 'production' && dsn) {
    Sentry.init({
        dsn,
        integrations: [
            Sentry.replayIntegration({
                blockAllMedia: false,
                // Every input masked, matching PostHog's session recording
                // (lib/analytics/identity.ts). Text stays readable.
                maskAllInputs: true,
                maskAllText: false,
                mask: [
                    'input[type="password"]',
                    'input[name="password"]',
                    'input[type="email"]',
                    '#card-element',
                    '[data-sentry-mask]',
                ],
            }),
        ],
        // Same intake bucket as the server's errors: see sentry.common.config.ts.
        tracesSampleRate: 0.05,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        debug: false,
    })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
