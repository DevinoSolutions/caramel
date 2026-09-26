import * as Sentry from '@sentry/nextjs'

const isProd = process.env.NODE_ENV === 'production'

export function initSentry(
    customOptions: Parameters<typeof Sentry.init>[0] = {},
) {
    if (!isProd || !process.env.NEXT_PUBLIC_SENTRY_DSN) return
    Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        // Errors and transactions share one intake bucket per project at the
        // self-hosted Sentry's nginx (5 envelopes/s, burst 30). At 1.0 this app
        // sent ~320k transactions a day, kept the bucket empty, and error
        // envelopes that arrived meanwhile were refused with 429 and lost
        // without a trace: a 2026-09-26 drill got 15 of 31 errors, then 0 of
        // 20, into Sentry, while the log line had all of them. Keep this low;
        // tests/unit/sentry-traces-sample-rate.test.ts holds the ceiling.
        tracesSampleRate: 0.05,
        debug: false,
        sendDefaultPii: true,
        ...customOptions,
    })
}
