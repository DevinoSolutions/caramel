import { cachedSearchSupportedSites } from '@/lib/anonymousReadCaches'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { storeSearchTerm } from '@/lib/storeDomain'
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

// T-6226: a one-character term is an ILIKE '%x%' scan over every visible
// coupon (0.29 s measured) for a result list of the first 20 alphabetical
// matches, which no shopper can use. Shorter terms answer an empty list
// without touching Postgres, like the empty term always has.
const MIN_SEARCH_TERM_LENGTH = 2

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
        // Shoppers paste full URLs (the box's placeholder is one), so the
        // query is reduced to a store domain before the substring match.
        const q = storeSearchTerm(
            String(body?.query ?? '').slice(0, 2048),
        ).slice(0, 100)
        if (q.length < MIN_SEARCH_TERM_LENGTH) {
            return NextResponse.json({ sites: [] })
        }

        try {
            // Through the LRU+TTL cache keyed by the normalized term, so the
            // same autocomplete prefix is one scan per 5 minutes, not one per
            // keystroke per visitor.
            const rows = await cachedSearchSupportedSites(q)
            return NextResponse.json({
                sites: rows.map(r => r.site).filter(Boolean),
            })
        } catch (err) {
            console.error('search-supported failed:', err)
            return handleRouteError(err, { req, message: 'Search failed' })
        }
    },
)
