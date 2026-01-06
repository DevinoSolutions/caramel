import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (process.env.NODE_ENV === 'production' && dsn) {
    Sentry.init({
        dsn,
        integrations: [
            Sentry.replayIntegration({
                blockAllMedia: false,
                maskAllInputs: false,
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
        tracesSampleRate: 1,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        debug: false,
    })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
