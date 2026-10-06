import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import type { RecentlyWorkedCouponsResponse } from '@/lib/recentlyWorkedCoupons'
import { getRecentlyWorkedCoupons } from '@/lib/recentlyWorkedCouponsCache'
import { NextResponse } from 'next/server'

// The landing page's "Codes that just worked" strip, fetched by the browser
// after hydration (components/RecentlyWorkedSection.tsx) so `/` stays a
// static, prebuilt page: the production image builds against an unreachable
// placeholder DATABASE_URL, and making the busiest page render per request
// just for a below-the-fold strip would trade first-paint speed for it.
//
// Per-process cache (recentlyWorkedCouponsCache.ts, 5 min) + a matching
// 5-minute edge cache — the rows carry absolute timestamps, so staleness
// never makes a "Just worked" line lie; the client re-applies the 24h window.
export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/recently-worked', rateLimit: 'read' },
    async ({ req }) => {
        try {
            const coupons = await getRecentlyWorkedCoupons()
            const body: RecentlyWorkedCouponsResponse = {
                coupons: [...coupons],
            }
            return NextResponse.json(body, {
                headers: {
                    'Cache-Control':
                        'public, s-maxage=300, stale-while-revalidate=300',
                },
            })
        } catch (error) {
            return handleRouteError(error, {
                req,
                message: 'Failed to load recently worked coupons.',
            })
        }
    },
)
