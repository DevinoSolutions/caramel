import {
    cachedFilterDiscountTypes,
    cachedFilterSites,
} from '@/lib/anonymousReadCaches'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { NextResponse } from 'next/server'

const DEFAULT_SITES_LIMIT = 20
const MAX_SITES_LIMIT = 100

// T-6229: a non-numeric value (`?sitesLimit=abc`) used to parse to NaN, which
// sailed through Math.min/Math.max and reached `LIMIT NaN` (unbounded: a 69 KB
// answer and a free cache-buster). Anything that is not a plain integer now
// falls back to the default; real integers clamp to 0..MAX as before.
function parseSitesLimit(raw: string | null): number {
    if (raw === null || !/^-?\d{1,9}$/.test(raw.trim())) {
        return DEFAULT_SITES_LIMIT
    }
    return Math.min(Math.max(Number.parseInt(raw, 10), 0), MAX_SITES_LIMIT)
}

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/filters', rateLimit: 'read' },
    async ({ req }) => {
        const url = new URL(req.url)
        const includeSitesParam = url.searchParams.get('includeSites')
        const includeSites = includeSitesParam !== 'false'
        const sitesLimit = parseSitesLimit(url.searchParams.get('sitesLimit'))

        try {
            // Both reads go through the in-process TTL caches (T-6226), keyed
            // by the parsed limit, so the query string cannot bust them.
            const sitesPromise = includeSites
                ? cachedFilterSites(sitesLimit)
                : Promise.resolve([])
            const typesPromise = cachedFilterDiscountTypes()

            const [sitesRaw, discountTypesRaw] = await Promise.all([
                sitesPromise,
                typesPromise,
            ])

            const sites = sitesRaw
                .map(s => s.site)
                .filter((site): site is string => Boolean(site))
                .sort((a, b) => a.localeCompare(b))
            const discountTypes = Array.from(
                new Set(
                    discountTypesRaw.map(d => d.discount_type).filter(Boolean),
                ),
            )

            return NextResponse.json(
                { sites, discountTypes },
                {
                    headers: {
                        'Cache-Control':
                            'public, s-maxage=300, stale-while-revalidate=300',
                    },
                },
            )
        } catch (error) {
            console.error('Failed to load coupon filter metadata:', error)
            return handleRouteError(error, {
                req,
                message: 'Failed to load coupon filter metadata',
            })
        }
    },
)
