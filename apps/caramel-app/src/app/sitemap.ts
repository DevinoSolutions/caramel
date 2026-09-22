import { listActiveSources, listStoreSitemapEntries } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import {
    STORE_SITEMAP_ROW_LIMIT,
    collapseStoreRows,
} from '@/lib/seo/sitemapStores'
import { bucketStoresByLetter, directoryPath } from '@/lib/seo/storeDirectory'
import type { MetadataRoute } from 'next'

// The store half of this sitemap reads the coupon catalog from Postgres, and
// the production image builds against a deliberately unreachable placeholder
// DATABASE_URL (see the Dockerfile's `.invalid` builder env) — so this route
// must be rendered per-request, never prerendered at build time. Crawlers hit
// it rarely and the read is a single indexed GROUP BY, so per-request is cheap.
export const dynamic = 'force-dynamic'

const origin = BASE_URL.replace(/\/+$/, '')

type StaticRoute = {
    path: string
    changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']
    priority: number
}

// Public marketing routes. Auth pages ((auth)/login, signup, verify) and
// /profile are deliberately absent — they are disallowed in robots.ts.
// /support is indexable and header-linked, so it belongs here (it was missing
// until 2026-09; GSC saw it only through links).
const STATIC_ROUTES: ReadonlyArray<StaticRoute> = [
    { path: '/', changeFrequency: 'weekly', priority: 1 },
    { path: '/coupons', changeFrequency: 'daily', priority: 0.9 },
    { path: '/supported-stores', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/apps', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/pricing', changeFrequency: 'monthly', priority: 0.7 },
    { path: '/support', changeFrequency: 'monthly', priority: 0.5 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
]

// /sources renders a table of ACTIVE sources. With none (prod had 0 on
// 2026-09-11 — `/api/sources` returned `[]`) it is an empty shell that the page
// itself noindexes ((marketing)/sources/page.tsx), so it is listed only when
// there is something to index. Same read the page uses.
const SOURCES_ROUTE: StaticRoute = {
    path: '/sources',
    changeFrequency: 'weekly',
    priority: 0.6,
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // One aggregate row per raw `coupons.site` (visible coupons only), then
    // collapsed to the CANONICAL registrable domain the page canonicalizes to
    // and filtered by the SAME indexability policy the page's robots meta
    // uses (src/lib/seo/storeIndexability.ts) — so every store <loc> here is
    // its own canonical and never a noindexed page. `lastModified` is the
    // newest `coupons.updated_at` folded into that base: a real catalog
    // timestamp, the freshness signal Google needs to re-read a sitemap.
    const [storeRows, activeSources] = await Promise.all([
        listStoreSitemapEntries(STORE_SITEMAP_ROW_LIMIT),
        listActiveSources(),
    ])
    const stores = collapseStoreRows(storeRows)

    const staticRoutes: StaticRoute[] =
        activeSources.length > 0
            ? [...STATIC_ROUTES, SOURCES_ROUTE]
            : [...STATIC_ROUTES]

    // The A–Z directory: its index plus ONLY the letter pages that have
    // stores, bucketed from the SAME collapsed entries as the store URLs
    // below (a letter with no stores is a 404, never an empty page). The
    // directory is the crawl path into the store pages — 8 of ~4,262 had any
    // internal inbound link before it — so it is listed with the hubs'
    // weight. Page 2+ of a split letter is noindex and deliberately absent.
    const letterPages: StaticRoute[] =
        stores.length > 0
            ? [
                  {
                      path: directoryPath(),
                      changeFrequency: 'weekly',
                      priority: 0.8,
                  },
                  ...bucketStoresByLetter(stores).map(bucket => ({
                      path: directoryPath(bucket.letter),
                      changeFrequency: 'weekly' as const,
                      priority: 0.6,
                  })),
              ]
            : []

    return [
        ...[...staticRoutes, ...letterPages].map(route => ({
            url: `${origin}${route.path}`,
            changeFrequency: route.changeFrequency,
            priority: route.priority,
        })),
        ...stores.map(store => ({
            url: `${origin}/coupons/${encodeURIComponent(store.base)}`,
            ...(store.lastModified ? { lastModified: store.lastModified } : {}),
            changeFrequency: 'daily' as const,
            priority: 0.7,
        })),
    ]
}
