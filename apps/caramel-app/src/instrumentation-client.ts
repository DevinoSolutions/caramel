import { defersAnalytics, onFirstActivity } from '@/lib/afterPageLoad'
import { SENTRY_RELEASE } from '@/lib/buildInfo'
import * as Sentry from '@sentry/nextjs'

// Next.js only loads client instrumentation from `instrumentation-client.ts`.
// This file was named `instrumentation.client.ts` until 2026-09-26, so the
// browser SDK never started: 0 browser events in 90 days of Sentry, and no
// client-side report (error boundary, captureMessage) ever arrived.

// Replay is Sentry's documented lazy-load path: the error SDK starts before
// hydration (Sentry.init below), so every error is still reported, and the Replay
// integration (rrweb) arrives in its own chunk. Because
// replaysOnErrorSampleRate is 1.0, Replay buffers EVERY session, which
// means a full DOM snapshot plus a mutation observer: in the first-load
// bundle it was the largest single cost on the landing page's mobile
// Lighthouse run, and deferred only to load + idle it still landed inside
// hydration. So on the marketing landing route(s) (defersAnalytics) it is
// added at the visitor's first activity, or 10 s after load; trade-off: an
// error thrown on the landing page before the first scroll, tap or
// keypress (and within 10 s of load) is reported without a replay. Every
// other route (app, auth, OAuth, consent) adds it right away.
function addReplay(): void {
    import('@sentry/nextjs')
        .then(lazySentry => {
            Sentry.addIntegration(
                lazySentry.replayIntegration({
                    blockAllMedia: false,
                    // Every input masked, matching PostHog's session
                    // recording (lib/analytics/identity.ts). Text stays
                    // readable.
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
            )
        })
        .catch(error => {
            // A failed chunk load costs the replay, never the page; the
            // error SDK is already running and reports it.
            Sentry.captureException(error, {
                tags: { operation: 'sentry_replay_lazy_load' },
            })
        })
}

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (process.env.NODE_ENV === 'production' && dsn) {
    Sentry.init({
        dsn,
        // Same release as the server and edge inits (sentry.common.config.ts).
        release: SENTRY_RELEASE,
        // Replay is added from its own chunk (addReplay above), not here.
        integrations: [],
        // Same intake bucket as the server's errors: see sentry.common.config.ts.
        tracesSampleRate: 0.05,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        debug: false,
    })
    if (defersAnalytics(window.location.pathname)) onFirstActivity(addReplay)
    else addReplay()
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
