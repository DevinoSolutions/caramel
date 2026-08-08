import { listStoreOptions } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import type { MetadataRoute } from 'next'

// The store half of this sitemap reads the coupon catalog from Postgres, and
// the production image builds against a deliberately unreachable placeholder
// DATABASE_URL (see the Dockerfile's `.invalid` builder env) — so this route
// must be rendered per-request, never prerendered at build time. Crawlers hit
// it rarely and the read is a single indexed DISTINCT, so per-request is cheap.
export const dynamic = 'force-dynamic'

const origin = BASE_URL.replace(/\/+$/, '')

// Upper bound on `/coupons/[store]` entries. The sitemap spec caps a single
// file at 50,000 URLs; this stays well under it and bounds the query. If the
// catalog ever outgrows it, the fix is a sitemap index, not a bigger number.
const STORE_URL_LIMIT = 5000

// Public marketing routes. Auth pages ((auth)/login, signup, verify) and
// /profile are deliberately absent — they are disallowed in robots.ts.
const STATIC_ROUTES: ReadonlyArray<{
    path: string
    changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']
    priority: number
}> = [
    { path: '/', changeFrequency: 'weekly', priority: 1 },
    { path: '/coupons', changeFrequency: 'daily', priority: 0.9 },
    { path: '/supported-stores', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/pricing', changeFrequency: 'monthly', priority: 0.7 },
    { path: '/sources', changeFrequency: 'weekly', priority: 0.6 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // Same read the /api/coupons/stores autocomplete uses: DISTINCT visible
    // sites, empty query = no ILIKE filter. No `lastModified` is emitted for
    // store pages because this row shape carries no timestamp — an invented
    // date is worse than none.
    const storeRows = await listStoreOptions('', STORE_URL_LIMIT)
    const stores = storeRows
        .map(row => row.site)
        .filter((site): site is string => Boolean(site && site.trim()))

    return [
        ...STATIC_ROUTES.map(route => ({
            url: `${origin}${route.path}`,
            changeFrequency: route.changeFrequency,
            priority: route.priority,
        })),
        ...stores.map(site => ({
            url: `${origin}/coupons/${encodeURIComponent(site)}`,
            changeFrequency: 'daily' as const,
            priority: 0.7,
        })),
    ]
}
