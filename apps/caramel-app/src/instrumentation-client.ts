import { defersAnalytics, onFirstActivity } from '@/lib/afterPageLoad'
import { browserSignalsTrackingOptOut } from '@/lib/analytics/trackingOptOut'
import { SENTRY_RELEASE } from '@/lib/buildInfo'
import { INJECTED_SCRIPT_DENY_URLS } from '@/lib/sentryInjectedScriptNoise'
import {
    SENTRY_DATA_COLLECTION,
    scrubReplayRecordingEvent,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
} from '@/lib/sentryPiiScrub'
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
//
// Replay is skipped entirely when the browser sends Global Privacy Control or
// Do Not Track (browserSignalsTrackingOptOut): addReplay is never called, so
// the rrweb chunk is not even fetched. Error reporting stays on. Caramel has
// no consent banner by design; honouring these signals is the consent gate.
// Replays land in the self-hosted Sentry on devino-first. Sentry's session
// sample is 10% (on-error stays 1.0), same as PostHog's, which is a project
// setting, see lib/analytics/identity.ts.
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
                        '.ph-sensitive',
                    ],
                    // Added to Sentry's default block list. PostHog blocks
                    // `.ph-no-capture` by default; this mirrors it here.
                    block: ['.ph-no-capture'],
                    // The network/navigation frames Replay records hold request
                    // URLs, which beforeSend/beforeBreadcrumb never see: scrub
                    // typed store-search text (?q=, ?search=) there too (T-7505).
                    beforeAddRecordingEvent: scrubReplayRecordingEvent,
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
        // 10% session / 1.0 on-error: the T-2008 standard, raised after the
        // self-hosted Sentry relay quota fix (#59/#60) lifted the 5 envelopes/s
        // limit.
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        // A third-party extension injects `executors/<n>.js` into our pages;
        // its throws are not ours (CARAMEL-Z, lib/sentryInjectedScriptNoise.ts).
        // Matched on the frame that threw, so our own errors still report.
        denyUrls: INJECTED_SCRIPT_DENY_URLS,
        // Same restrictive baseline and transaction model as the server, see
        // sentry.common.config.ts. The page URL, Referer and fetch /
        // navigation breadcrumbs of the sign-in callback pages still carry
        // `?code=…&state=…`; the scrub strips those before they leave the
        // browser.
        dataCollection: SENTRY_DATA_COLLECTION,
        traceLifecycle: 'static',
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryEvent,
        beforeBreadcrumb: scrubSentryBreadcrumb,
        debug: false,
    })
    if (!browserSignalsTrackingOptOut()) {
        if (defersAnalytics(window.location.pathname)) {
            onFirstActivity(addReplay)
        } else {
            addReplay()
        }
    }
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
