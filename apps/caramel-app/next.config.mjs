import { withSentryConfig } from '@sentry/nextjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBuildSha } from './scripts/build-sha.mjs'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = path.resolve(packageRoot, '..', '..')

// Honest build stamp: the app package.json version, exposed to both server and
// browser as NEXT_PUBLIC_APP_VERSION (env.client.ts reads it, falling back to
// '0.0.0-dev'). Read here so it needs no build ARG / hand-set env var.
const appVersion = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

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

// Mirrors src/lib/env.client.ts's BASE_URL fallback and robots.ts's
// PRODUCTION_ORIGINS. Read at config-evaluation time, which is build time —
// the same moment NEXT_PUBLIC_BASE_URL is baked into the image (Dockerfile
// build-arg), so the header and robots.ts always agree about the host.
const PRODUCTION_ORIGINS = [
    'https://grabcaramel.com',
    'https://www.grabcaramel.com',
]
const IS_PRODUCTION_HOST = PRODUCTION_ORIGINS.includes(
    (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://grabcaramel.com').replace(
        /\/+$/,
        '',
    ),
)

// Resolved at config-evaluation time, which is BUILD time, and inlined into
// the bundle by `env` below — so /api/version reports the commit this image
// was built from and cannot drift from the code it ships. See
// scripts/build-sha.mjs for where the value comes from in each build context.
const GIT_COMMIT_SHA = resolveBuildSha()

/** @type {import('next').NextConfig} */
const nextConfig = {
    env: { GIT_COMMIT_SHA },
    // F-016 one-root-compose: emit a self-contained server (.next/standalone)
    // so the Docker runner stage boots `node apps/caramel-app/server.js` with a
    // traced, minimal node_modules instead of the whole install. Pairs with
    // outputFileTracingRoot below (monorepo root) so the trace resolves
    // workspace deps correctly.
    output: 'standalone',
    outputFileTracingRoot: workspaceRoot,
    env: {
        NEXT_PUBLIC_APP_VERSION: appVersion,
    },
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
            // YouTube video thumbnails, used by the click-to-load video facade
            // in WhyNot.tsx so no YouTube iframe (and no YouTube cookie) loads
            // until the visitor actually asks for the video.
            {
                protocol: 'https',
                hostname: 'i.ytimg.com',
                port: '',
                pathname: '/vi/**',
            },
        ],
    },
    async headers() {
        const headers = [{ source: '/:path*', headers: SECURITY_HEADERS }]
        // Belt-and-braces with src/app/robots.ts: robots.txt only asks a
        // crawler not to fetch a page, while X-Robots-Tag keeps an
        // already-fetched non-production URL (dev.grabcaramel.com, a preview
        // host, localhost) out of the index outright. Keep the host list in
        // sync with robots.ts's PRODUCTION_ORIGINS.
        if (!IS_PRODUCTION_HOST) {
            headers.push({
                source: '/:path*',
                headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
            })
        }
        return headers
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
          })
        : nextConfig

export default sentryConfig
