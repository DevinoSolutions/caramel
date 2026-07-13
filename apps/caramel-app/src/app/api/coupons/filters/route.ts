import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { listFilterDiscountTypes, listFilterSites } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/filters', rateLimit: 'read' },
    async ({ req }) => {
        const url = new URL(req.url)
        const includeSitesParam = url.searchParams.get('includeSites')
        const includeSites = includeSitesParam !== 'false'
        const rawLimit = parseInt(
            url.searchParams.get('sitesLimit') || '20',
            10,
        )
        const sitesLimit = Math.min(Math.max(rawLimit, 0), 100)

        try {
            const sitesPromise = includeSites
                ? listFilterSites(sitesLimit)
                : Promise.resolve([])
            const typesPromise = listFilterDiscountTypes()

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
