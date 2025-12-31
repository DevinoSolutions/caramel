import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { withSentryConfig } from '@sentry/nextjs'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = path.resolve(packageRoot, '..', '..')

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
}

// Only apply Sentry in production to allow Turbopack in development
const sentryConfig =
    process.env.NODE_ENV === 'production'
        ? withSentryConfig(nextConfig, {
              org: 'devino',
              project: 'caramel',
              silent: !process.env.CI,
              widenClientFileUpload: true,
              tunnelRoute: '/monitoring',
              disableLogger: true,
              automaticVercelMonitors: true,
          })
        : nextConfig

export default sentryConfig
