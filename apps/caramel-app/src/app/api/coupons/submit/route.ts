import { withRoute } from '@/lib/api/withRoute'
import { recordWorked } from '@/lib/couponSignals'
import { submitShopperCoupon } from '@/lib/couponsRepo'
import { env } from '@/lib/env'
import {
    ShopperSubmissionLimitError,
    normalizeShopperCode,
} from '@/lib/shopperCoupons'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/coupons/submit — a signed-in shopper adds a coupon code to the
// catalog. Two callers, one route:
//   - the website's "Add a code" form on /coupons/<store> (source 'manual',
//     cookie session, same origin), and
//   - the extension background (source 'checkout', bearer token): the shopper
//     typed the code at checkout and the store accepted it.
//
// withRoute options, mirroring coupons/[id]/report:
//   - origin: true  — isOriginAllowed passes same-origin browser requests AND
//     the extension protocols (and a missing Origin, which a background fetch
//     under host_permissions may send), and refuses any other cross-origin
//     page. NOT 'extension': that would lock out the website form.
//   - NO cors / NO OPTIONS export — same reasoning as the report route: the
//     website call is same-origin and the MV3 background fetch bypasses CORS
//     through host_permissions, so CORS headers would be dead ceremony.
//   - auth: 'session' — better-auth's bearer plugin resolves the extension's
//     token through the same gate as a cookie, so one option covers both
//     callers. No session → 401 before anything else runs.
//   - rateLimit: 'mutation', plus the per-shopper daily cap inside
//     submitShopperCoupon (the cap, not this bucket, bounds catalog growth).
//
// Source semantics. A 'manual' add is UNVERIFIED: nobody has seen the store
// accept it, so it must not stamp a trust signal. A 'checkout' capture IS a
// store acceptance, so it also records the coupon as worked through the
// existing couponSignals.recordWorked (the same writer POST /coupons/[id]/report
// uses) and the #284 "just worked" display logic needs no new code. Checkout
// capture is switchable globally: SHOPPER_CODE_CAPTURE_ENABLED off → 403
// 'capture-disabled' and nothing is written.
//
// "A real store" is exactly what the store page uses to decide it is a store
// (resolveStoreDomain non-null; storeIndexability's 'not-a-store'), so a manual
// add from any /coupons/<store> page that renders the form always resolves.
// A store with no coupons yet is still a store.
const SubmitBodySchema = z.object({
    site: z.string().trim().min(1).max(253),
    code: z.string(),
    source: z.enum(['checkout', 'manual']),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'coupons/submit',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: SubmitBodySchema,
    },
    async ({ body, session }) => {
        const userId = session?.user?.id
        if (!userId) {
            // withRoute's auth gate already 401s a missing session; this
            // narrows the type and covers a malformed session object.
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (body.source === 'checkout' && !env.SHOPPER_CODE_CAPTURE_ENABLED) {
            return NextResponse.json(
                { error: 'capture-disabled' },
                { status: 403 },
            )
        }

        // submitShopperCoupon re-validates both and throws a plain Error on bad
        // input; validating here is what turns that into a 422 instead of a 500.
        const code = normalizeShopperCode(body.code)
        if (code === null) {
            return NextResponse.json({ error: 'invalid-code' }, { status: 422 })
        }
        const base = resolveStoreDomain(body.site)
        if (base === null) {
            return NextResponse.json({ error: 'not-a-store' }, { status: 422 })
        }

        let result: { couponId: string; created: boolean }
        try {
            result = await submitShopperCoupon({
                base,
                code,
                source: body.source,
                userId,
            })
        } catch (error) {
            // The one expected failure: an anticipated, user-facing limit, not
            // an incident. Everything else propagates to withRoute's
            // handleRouteError (Sentry + 500).
            if (error instanceof ShopperSubmissionLimitError) {
                return NextResponse.json(
                    { error: 'daily-limit' },
                    { status: 429 },
                )
            }
            throw error
        }

        if (body.source === 'checkout') {
            // Awaited and NOT caught: if the stamp fails the shopper-visible
            // result ("worked") would be a lie, so the failure surfaces as a 500
            // and the extension retries/logs it. Re-stamping on a retry is
            // idempotent (an upsert of lastWorkedAt).
            await recordWorked(result.couponId)
        }

        return NextResponse.json({
            couponId: result.couponId,
            created: result.created,
            status: body.source === 'checkout' ? 'worked' : 'unverified',
        })
    },
)
