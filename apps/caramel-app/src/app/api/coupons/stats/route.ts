import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { getCouponStats } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/stats', rateLimit: 'read' },
    async ({ req }) => {
        try {
            const { total, expired } = await getCouponStats()

            return NextResponse.json(
                {
                    total,
                    expired,
                    active: total - expired,
                },
                {
                    headers: {
                        'Cache-Control':
                            'public, s-maxage=300, stale-while-revalidate=300',
                    },
                },
            )
        } catch (error) {
            console.error('Failed to fetch coupon stats:', error)
            return handleRouteError(error, {
                req,
                message: 'Failed to fetch stats',
            })
        }
    },
)
