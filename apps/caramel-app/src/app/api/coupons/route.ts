import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { attachSignals } from '@/lib/couponSignals'
import { listCoupons } from '@/lib/couponsRepo'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { NextResponse } from 'next/server'

// Registrable domain via the Public Suffix List. Replaces a local
// "last two labels" helper that collapsed mymemory.co.uk to the bare suffix
// co.uk and then served every UK store's coupons — see resolveStoreDomain.
const getBaseDomain = resolveStoreDomain

export const GET = withRoute(
    { method: 'GET', routeName: 'coupons', rateLimit: 'read' },
    async ({ req }) => {
        const url = new URL(req.url)
        const site = url.searchParams.get('site') || undefined
        const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
        const rawLimit = parseInt(url.searchParams.get('limit') || '10', 10)
        // Cap page at 500 so scrapers can't walk the catalog indefinitely
        // with `page=999999`. Real users never paginate that far.
        const page =
            Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 500) : 1
        const limit =
            Number.isFinite(rawLimit) && rawLimit > 0
                ? Math.min(rawLimit, 50)
                : 10
        // Cap search + keyword params to keep ILIKE patterns cheap.
        const search =
            (url.searchParams.get('search') || '').slice(0, 100) || undefined
        const type = url.searchParams.get('type') || undefined
        const keyWords =
            (url.searchParams.get('key_words') || '').slice(0, 200) || undefined

        let baseSite: string | undefined
        if (site) {
            const base = getBaseDomain(site)
            if (!base) {
                return NextResponse.json(
                    { error: 'Invalid site parameter' },
                    { status: 400 },
                )
            }
            baseSite = base
        }

        try {
            const skip = Math.max(0, (page - 1) * limit)

            const { coupons, total } = await listCoupons({
                baseSite,
                search,
                type,
                keyWords,
                limit,
                skip,
            })

            const hasMore = skip + coupons.length < total

            // Attach the app-owned trust signal (lastWorkedAt) from
            // coupon_signals — a keyed lookup in OUR Postgres merged in app
            // code, NOT a join into the external read-only catalog (which has
            // no such column). Empty signals → each coupon gets
            // lastWorkedAt:null, which the card simply doesn't render; that's
            // the normal state until the extension starts reporting (W2). The
            // 60s edge cache below is kept as-is — this signal is low-stakes,
            // so 60s of staleness is fine.
            const couponsWithSignals = await attachSignals(coupons)

            // 60s edge cache with a 60s grace window. Coupons change on a
            // scrape cycle (minutes-hours), so 60s staleness is invisible
            // to users and offloads almost all scraping traffic to CDN.
            return NextResponse.json(
                {
                    coupons: couponsWithSignals,
                    page,
                    limit,
                    total,
                    hasMore,
                },
                {
                    headers: {
                        'Cache-Control':
                            'public, s-maxage=60, stale-while-revalidate=60',
                    },
                },
            )
        } catch (error) {
            console.error('Error fetching coupons:', error)
            return handleRouteError(error, {
                req,
                message: 'Error fetching coupons.',
            })
        }
    },
)
