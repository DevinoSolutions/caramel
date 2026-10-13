import { BASE_URL } from '@/lib/env.client'
import { AI_CRAWLERS } from '@/lib/seo/aiCrawlers'
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
    // One-time post-install screen the extension opens (noindex in its page).
    '/welcome',
    '/profile',
    '/monitoring',
    // Next.js RSC payload fetches (`<Link>` prefetch from Googlebot's
    // renderer). Crawl stats 2026-10-10: 55% of 11.4K Googlebot requests in 90
    // days were `?_rsc=` payloads, starving discovery of store pages and A-Z
    // hubs. Safe: the RSC payload of the initial render is inlined in the
    // HTML, so indexing never needs these fetches. `_rsc` is appended to the
    // existing query string, so it can be first (`?_rsc=`) or later (`&_rsc=`).
    '/*?_rsc=',
    '/*&_rsc=',
]

export default function robots(): MetadataRoute.Robots {
    if (!isProduction) {
        return { rules: [{ userAgent: '*', disallow: '/' }] }
    }

    return {
        rules: [
            { userAgent: '*', allow: '/', disallow: DISALLOWED_PATHS },
            // Explicit AI-crawler allow group (src/lib/seo/aiCrawlers.ts).
            // Same disallow set as `*`: the private paths stay private for
            // answer engines too; the point is an unambiguous, named
            // invitation for everything else.
            // /api/coupons is the one API an agent is TOLD to call (the
            // caramel-coupons skill, /agent-setup/prompt.md); a fetch tool
            // that honours robots must not be locked out of it. The longer
            // allow rule wins over the shorter `/api/` disallow.
            {
                userAgent: [...AI_CRAWLERS],
                allow: ['/', '/api/coupons'],
                disallow: DISALLOWED_PATHS,
            },
        ],
        sitemap: `${origin}/sitemap.xml`,
    }
}
