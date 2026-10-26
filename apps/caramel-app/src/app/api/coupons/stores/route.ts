import { handleRouteError } from '@/lib/api/handleRouteError'
import { withoutSearchText } from '@/lib/api/withoutSearchText'
import { withRoute } from '@/lib/api/withRoute'
import { listStoreOptions } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// Same T-6229 bug class as coupons/filters' sitesLimit: a non-numeric value
// (`?limit=abc`) parsed to NaN, sailed through Math.min/Math.max and reached
// `LIMIT NaN` (an unbounded answer and a free cache-buster). Anything that is
// not a plain integer now falls back to the default; real integers clamp to
// 1..MAX as before.
function parseStoresLimit(raw: string | null): number {
    if (raw === null || !/^-?\d{1,9}$/.test(raw.trim())) {
        return DEFAULT_LIMIT
    }
    return Math.min(Math.max(Number.parseInt(raw, 10), 1), MAX_LIMIT)
}

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons/stores', rateLimit: 'read' },
    async ({ req }) => {
        const url = new URL(req.url)
        // Capped like /api/coupons' `search` and the supported-store search,
        // to keep the ILIKE pattern cheap.
        const q = (url.searchParams.get('q')?.trim() || '').slice(0, 100)
        const limit = parseStoresLimit(url.searchParams.get('limit'))

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
            // The typed search text must not reach the log or Sentry through
            // an error message (withoutSearchText.ts).
            const safeError = withoutSearchText(error, [q])
            console.error('Failed to load store options:', safeError)
            return handleRouteError(safeError, {
                req,
                message: 'Failed to load store options',
            })
        }
    },
)
