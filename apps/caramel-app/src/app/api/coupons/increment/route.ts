import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { incrementCouponUsage } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Lenient — `id` is coerced/validated by hand below exactly as before
// (PRESERVED per PLAN-F-007.md §Breaking, not tightened to 422): the
// schema only needs to accept whatever shape a caller sends without ever
// rejecting it itself, deferring to the same `!= null ? String(id) : ''`
// + regex check the route always did.
const IncrementBodySchema = z.object({
    id: z.unknown().optional(),
})

// Usage counter for a coupon. POST (not GET) so it can't be triggered by
// browser/CDN prefetch — a mutation must never ride a cacheable GET.
// id accepted via ?id= (back-compat) or JSON body; coupons.id is an integer.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/increment',
        rateLimit: 'mutation',
        origin: true,
        body: IncrementBodySchema,
    },
    async ({ req, body }) => {
        const url = new URL(req.url)
        let idRaw = url.searchParams.get('id') || ''
        if (!idRaw) {
            idRaw = body?.id != null ? String(body.id) : ''
        }
        if (!/^\d{1,18}$/.test(idRaw)) {
            return NextResponse.json(
                { error: 'Invalid or missing coupon ID' },
                { status: 400 },
            )
        }
        const id = Number(idRaw)

        try {
            const row = await incrementCouponUsage(id)
            if (!row) {
                return NextResponse.json(
                    { error: 'Coupon not found' },
                    { status: 404 },
                )
            }
            return NextResponse.json(row)
        } catch (error) {
            console.error('Error incrementing coupon usage:', error)
            return handleRouteError(error, {
                req,
                message: 'Error updating coupon usage.',
            })
        }
    },
)
