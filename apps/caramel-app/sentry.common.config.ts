import * as Sentry from '@sentry/nextjs'

const isProd = process.env.NODE_ENV === 'production'

export function initSentry(
    customOptions: Parameters<typeof Sentry.init>[0] = {},
) {
    if (!isProd || !process.env.NEXT_PUBLIC_SENTRY_DSN) return
    Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        tracesSampleRate: 1,
        debug: false,
        sendDefaultPii: true,
        ...customOptions,
    })
}
