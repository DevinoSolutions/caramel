import { withRoute } from '@/lib/api/withRoute'
import { recordWorked } from '@/lib/couponSignals'
import { submitShopperCoupon } from '@/lib/couponsRepo'
import { env } from '@/lib/env'
import { isExtensionOrigin } from '@/lib/rateLimit'
import {
    MIN_CHECKOUT_CONSENT_PROMPT_VERSION,
    ShopperSubmissionLimitError,
    UnknownStoreError,
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
// 'capture-disabled' and nothing is written. Only the extension may send
// source 'checkout': a request carrying an Origin that is not an extension
// origin (a web page, the Caramel site included) gets 403
// 'checkout-source-extension-only'. A MISSING Origin is accepted, since a
// background fetch under host_permissions may omit it. This is depth, not
// authentication: Origin is trivially forged by a non-browser client (see the
// recordWorked TODO below).
//
// Consent proof (owner rule 2026-10-06: a shopper's code may be captured ONLY
// after an explicit in-extension opt-in). SHOPPER_CODE_CAPTURE_ENABLED is
// GLOBAL, so on its own it would let extension builds 1.4.3-1.4.7 (no prompt,
// capture on by default) capture the moment it is switched on. Hence the
// request itself must carry the proof: a checkout submission needs
// consent = { choice: 'accepted', promptVersion >= MIN_CHECKOUT_CONSENT_PROMPT_VERSION, at },
// exactly the record the extension (1.4.9+) stored when the shopper said yes.
// Missing or invalid proof → 403 'consent-required' and nothing is written.
// Honest limit: this is a
// client-asserted claim, not cryptographic proof (like Origin above): it
// reliably refuses every build that does not know about consent, and it moves
// the "did the shopper opt in" question into the request so it is auditable.
// The 'manual' website form needs no consent and its body is not looked at for it.
//
// Check order: origin + session (401) + rate limit + body schema (422), all in
// withRoute → checkout from a non-extension Origin (403) → capture flag off
// (403 'capture-disabled', as before) → consent proof (403 'consent-required')
// → code/site checks (422) → write. The flag is checked
// first so an OFF server answers exactly what it always did; with the flag ON,
// an old build is refused here.
//
// "A real store" is two checks. resolveStoreDomain (the store page's own
// canonicalizer; null means 'not-a-store') proves the string is a registrable
// domain, which any spam domain is. submitShopperCoupon then proves it is a
// KNOWN store (a supplier coupon or a store_configs row exists; shopper rows
// prove nothing) and throws UnknownStoreError otherwise. Both map to the same
// 422 { error: 'not-a-store' }: without the second, one shopper row would make
// /coupons/<any-domain> indexable and sitemap-listed. A known store with no
// coupons yet is still a store.
const SubmitBodySchema = z.object({
    site: z.string().trim().min(1).max(253),
    code: z.string(),
    source: z.enum(['checkout', 'manual']),
    // Deliberately `unknown` here: a malformed or absent proof on a checkout
    // submission must answer 403 'consent-required' (below), not the generic
    // 422 body-schema error, and a manual submission never reads it.
    consent: z.unknown().optional(),
})

// What the extension sends (background.js submitShopperCode): the stored
// checkoutCodeSharingConsent record, accepted only. `at` is the ISO-8601 string
// the extension stores; strict, so an unknown key is refused rather than ignored.
const CheckoutConsentProofSchema = z.strictObject({
    choice: z.literal('accepted'),
    promptVersion: z.number().int().min(MIN_CHECKOUT_CONSENT_PROMPT_VERSION),
    at: z
        .string()
        .max(64)
        .refine(value => !Number.isNaN(Date.parse(value)), {
            message: 'at must be a parseable date',
        }),
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
    async ({ req, body, session }) => {
        const userId = session?.user?.id
        if (!userId) {
            // withRoute's auth gate already 401s a missing session; this
            // narrows the type and covers a malformed session object.
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (body.source === 'checkout') {
            const origin = req.headers.get('origin')
            if (origin !== null && !isExtensionOrigin(req)) {
                return NextResponse.json(
                    { error: 'checkout-source-extension-only' },
                    { status: 403 },
                )
            }
        }

        if (body.source === 'checkout' && !env.SHOPPER_CODE_CAPTURE_ENABLED) {
            return NextResponse.json(
                { error: 'capture-disabled' },
                { status: 403 },
            )
        }

        if (
            body.source === 'checkout' &&
            !CheckoutConsentProofSchema.safeParse(body.consent).success
        ) {
            // An anticipated refusal (every pre-1.4.9 build lands here once the
            // flag is on), not an incident: no Sentry noise, and nothing about
            // the code or the rejected payload is logged.
            return NextResponse.json(
                { error: 'consent-required' },
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
            if (error instanceof UnknownStoreError) {
                return NextResponse.json(
                    { error: 'not-a-store' },
                    { status: 422 },
                )
            }
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
            // TODO: checkout worked-stamps are client-asserted; weight/cap per user before trusting them for ranking.
            await recordWorked(result.couponId)
        }

        return NextResponse.json({
            couponId: result.couponId,
            created: result.created,
            status: body.source === 'checkout' ? 'worked' : 'unverified',
        })
    },
)
