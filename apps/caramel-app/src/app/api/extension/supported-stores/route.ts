import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { getSupportedStoresPayload } from '@/lib/supportedStoresCache'
import { NextResponse } from 'next/server'

// Public read: the payload is xpath selectors already shipped to every
// extension install (background.js), so gating it behind a key has no
// secrecy value (F-003). Rate-limited like any other public read route. A
// stale x-api-key header from a pre-F-003 extension build is simply
// ignored — no cutover required, see PLAN-F-003.md §Breaking. KEYLESS by
// design post-F-003 — CR-8: no apiKey concern on this route.
//
// The ~1.2 MB body is built once per 5 min by supportedStoresCache (the
// SELECT + row mapping + stringify used to run on EVERY hit and blocked the
// event loop for seconds — one of the loads behind the 2026-08/09
// healthcheck-flap outages). The strong ETag lets a client that already
// holds the current payload get a 304 instead of 1.2 MB.
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=300'

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/supported-stores',
        rateLimit: 'read',
    },
    async ({ req }) => {
        try {
            const { body, etag } = await getSupportedStoresPayload()

            if (req.headers.get('if-none-match') === etag) {
                return new NextResponse(null, {
                    status: 304,
                    headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
                })
            }

            return new NextResponse(body, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    ETag: etag,
                    'Cache-Control': CACHE_CONTROL,
                },
            })
        } catch (error) {
            console.error('[API][extension/supported-stores] error', error)
            return handleRouteError(error, {
                req,
                message: 'Internal server error',
            })
        }
    },
)
