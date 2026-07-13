import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { searchSupportedSites } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Lenient — `query` is coerced/defaulted by hand below exactly as before
// (F-007's Breaking changes: this route's behavior is PRESERVED, not
// tightened), so the schema only needs to accept whatever shape a caller
// sends without ever 422ing. z.unknown() defers ALL type/shape handling
// to the same String(body?.query ?? '') the route always did.
const SearchSupportedBodySchema = z.object({
    query: z.unknown().optional(),
})

// Store-name autocomplete. Post-DB-split this must read the coupons catalog
// via couponsRepo (the old Prisma "Coupon" model was dropped). Surfaces any
// store that has visible coupons (verified, restricted, or not-yet-verified).
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'sites/search-supported',
        rateLimit: 'read',
        body: SearchSupportedBodySchema,
    },
    async ({ req, body }) => {
        const q = String(body?.query ?? '')
            .trim()
            .slice(0, 100)
        if (!q) return NextResponse.json({ sites: [] })

        try {
            const rows = await searchSupportedSites(q)
            return NextResponse.json({
                sites: rows.map(r => r.site).filter(Boolean),
            })
        } catch (err) {
            console.error('search-supported failed:', err)
            return handleRouteError(err, { req, message: 'Search failed' })
        }
    },
)
