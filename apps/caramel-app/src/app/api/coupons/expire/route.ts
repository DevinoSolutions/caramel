import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { expireCoupons } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Lenient — `ids` is validated by hand below exactly as before (PRESERVED
// per PLAN-F-007.md §Breaking, not tightened to 422): the schema only
// needs to accept whatever shape a caller sends without ever rejecting it
// itself, deferring to the same Array.isArray(ids) check the route always
// did (a non-array `ids` degrades to `{count: 0}`, not an error).
const ExpireBodySchema = z.object({
    ids: z.unknown().optional(),
})

// Bulk-expire coupons. Privileged: this permanently flips `expired=TRUE`, so
// it requires the server-only COUPONS_ADMIN_SECRET bearer (never shipped to
// the extension or any client) — not just an origin check. Bounded to 50
// integer ids per call.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/expire',
        rateLimit: 'mutation',
        origin: true,
        apiKey: 'trustedServer',
        body: ExpireBodySchema,
    },
    async ({ req, body }) => {
        const rawIds = body?.ids
        const ids = Array.isArray(rawIds) ? rawIds : []
        if (ids.length === 0) {
            return NextResponse.json({ count: 0 })
        }
        if (ids.length > 50) {
            return NextResponse.json(
                { error: 'Too many ids (max 50)' },
                { status: 400 },
            )
        }
        const clean = Array.from(
            new Set(
                ids
                    .map(i => String(i))
                    .filter(s => /^\d{1,18}$/.test(s))
                    .map(Number),
            ),
        )
        if (clean.length === 0) {
            return NextResponse.json({ count: 0 })
        }

        try {
            const count = await expireCoupons(clean)
            return NextResponse.json({ count })
        } catch (error) {
            console.error('Error expiring coupons:', error)
            return handleRouteError(error, {
                req,
                message: 'Error marking coupons as expired.',
            })
        }
    },
)
