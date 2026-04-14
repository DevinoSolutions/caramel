import { withSentryConfig } from '@sentry/nextjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = path.resolve(packageRoot, '..', '..')

// Universally-safe security headers. CSP is deliberately NOT included
// here — it's easy to break third-party scripts (Sentry, GA, RevenueCat)
// with a wrong policy and it deserves its own rollout.
const SECURITY_HEADERS = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=()',
    },
    {
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains',
    },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
    outputFileTracingRoot: workspaceRoot,
    turbopack: {
        root: workspaceRoot,
    },
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'www.google.com',
                port: '',
                pathname: '/s2/favicons/**',
            },
        ],
    },
    async headers() {
        return [{ source: '/:path*', headers: SECURITY_HEADERS }]
    },
}

// Only apply Sentry in production to allow Turbopack in development
const sentryConfig =
    process.env.NODE_ENV === 'production'
        ? withSentryConfig(nextConfig, {
              org: 'devino',
              project: 'caramel',
              sentryUrl: 'https://sentry.devino.ca',
              silent: !process.env.CI,
              widenClientFileUpload: true,
              tunnelRoute: '/monitoring',
              disableLogger: true,
              automaticVercelMonitors: true,
          })
        : nextConfig

export default sentryConfig
