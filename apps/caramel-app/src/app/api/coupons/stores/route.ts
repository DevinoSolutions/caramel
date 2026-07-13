import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { listStoreOptions } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/stores', rateLimit: 'read' },
    async ({ req }) => {
        const url = new URL(req.url)
        const q = url.searchParams.get('q')?.trim() || ''
        const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10)
        const limit = Math.min(Math.max(rawLimit, 1), 50)

        try {
            const rows = await listStoreOptions(q, limit)

            const sites = rows.map(s => s.site).filter(Boolean)

            return NextResponse.json(
                { sites },
                {
                    headers: {
                        'Cache-Control':
                            'public, s-maxage=120, stale-while-revalidate=120',
                    },
                },
            )
        } catch (error) {
            console.error('Failed to load store options:', error)
            return handleRouteError(error, {
                req,
                message: 'Failed to load store options',
            })
        }
    },
)
