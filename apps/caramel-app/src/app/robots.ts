import { BASE_URL } from '@/lib/env.client'
import type { MetadataRoute } from 'next'

// The only origins that may be indexed. Every other BASE_URL a build can carry
// (dev.grabcaramel.com, a preview host, localhost) serves a blanket
// `Disallow: /` and NO sitemap line, so a staging deploy can never leak
// duplicate content into the index. next.config.mjs carries the same host list
// for the X-Robots-Tag belt-and-braces header — keep the two in sync.
const PRODUCTION_ORIGINS = new Set([
    'https://grabcaramel.com',
    'https://www.grabcaramel.com',
])

const origin = BASE_URL.replace(/\/+$/, '')
const isProduction = PRODUCTION_ORIGINS.has(origin)

// Authenticated surfaces, the Sentry tunnel, and the machine-only API — none
// of them are content, and all of them waste crawl budget.
const DISALLOWED_PATHS = [
    '/api/',
    '/login',
    '/signup',
    '/verify',
    '/profile',
    '/monitoring',
]

export default function robots(): MetadataRoute.Robots {
    if (!isProduction) {
        return { rules: [{ userAgent: '*', disallow: '/' }] }
    }

    return {
        rules: [{ userAgent: '*', allow: '/', disallow: DISALLOWED_PATHS }],
        sitemap: `${origin}/sitemap.xml`,
    }
}
