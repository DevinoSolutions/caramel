import * as Sentry from '@sentry/nextjs'
import { SENTRY_RELEASE } from './src/lib/buildInfo'
import { scrubRejectedRedirectEvent } from './src/lib/rejectedRedirectEventScrub'
import {
    SENTRY_DATA_COLLECTION,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
} from './src/lib/sentryPiiScrub'

const isProd = process.env.NODE_ENV === 'production'

export function initSentry(
    customOptions: Parameters<typeof Sentry.init>[0] = {},
) {
    if (!isProd || !process.env.NEXT_PUBLIC_SENTRY_DSN) return
    Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        // The build's commit sha (undefined when the build could not resolve
        // one). Shared by the server and edge inits; the browser init in
        // src/instrumentation-client.ts sets the same value.
        release: SENTRY_RELEASE,
        // Errors and transactions share one intake bucket per project at the
        // self-hosted Sentry's nginx (5 envelopes/s, burst 30). At 1.0 this app
        // sent ~320k transactions a day, kept the bucket empty, and error
        // envelopes that arrived meanwhile were refused with 429 and lost
        // without a trace: a 2026-09-26 drill got 15 of 31 errors, then 0 of
        // 20, into Sentry, while the log line had all of them. Keep this low;
        // tests/unit/sentry-traces-sample-rate.test.ts holds the ceiling.
        tracesSampleRate: 0.05,
        debug: false,
        // Restrictive on purpose (T-5535 M5 turned `sendDefaultPii` off; SDK v11
        // replaced that flag with `dataCollection`, whose unset default is now
        // permissive). Loose, the SDK attaches the caller's IP, the Cookie /
        // Authorization headers, request bodies and DB queries to events. This
        // baseline loses only those; triage here runs on route / method /
        // status tags, the release, the trace id and the user id, all of which
        // stay (the id is set explicitly by Sentry.setUser, which
        // `userInfo` does not govern).
        dataCollection: SENTRY_DATA_COLLECTION,
        // SDK v11 streams spans by default, and under streaming
        // beforeSendTransaction never runs, so span urls would skip the scrub
        // below. 'static' keeps the v10 transaction model the scrub is built on.
        traceLifecycle: 'static',
        // Defence in depth on top of the baseline: sentryPiiScrub strips
        // credential-shaped headers, params, bearer tokens, e-mails and IPs
        // from errors, transactions (incl. span urls) and breadcrumbs, whatever
        // the SDK or a call site put there. The rejected-redirect scrub then
        // also drops the whole query string of its own events.
        beforeSend: event => {
            const scrubbed = scrubSentryEvent(event)
            return scrubbed && scrubRejectedRedirectEvent(scrubbed)
        },
        beforeSendTransaction: scrubSentryEvent,
        beforeBreadcrumb: scrubSentryBreadcrumb,
        ...customOptions,
    })
}
