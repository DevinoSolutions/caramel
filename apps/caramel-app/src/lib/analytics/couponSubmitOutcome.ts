// src/lib/analytics/couponSubmitOutcome.ts
//
// One server-side PostHog event per POST /api/coupons/submit request, naming
// what the route DID with it.
//
// Why: shopper code capture went live 2026-10-10 and the DB still had zero
// shopper rows. Most refusals in the route answer 4xx on purpose and do not
// reach Sentry (an old extension build without consent, the capture flag off,
// a duplicate code are anticipated outcomes, not incidents), there are no
// Traefik access logs and traces are sampled at 5%. So "nobody typed a code"
// and "every attempt was refused" looked identical. This event makes the
// difference a query.
//
// Read it in PostHog: event `coupon_submit_outcome`, break down by `outcome`
// (and `submit_source`). See the PR that added this for the exact HogQL.
//
// No PII, by construction: the event carries NO code value, user id, IP or
// email, and a constant distinct id with `$process_person_profile: false`
// (no person is minted). The only free-form value is the store's registrable
// domain, and only once the route has resolved one.
import * as Sentry from '@sentry/nextjs'
import { after } from 'next/server'
import { captureServerEvent } from './posthogServer'

/**
 * Every way a /api/coupons/submit request can end. One name per distinct
 * outcome the route (or withRoute, before the handler runs) produces.
 */
export const COUPON_SUBMIT_OUTCOMES = [
    /** 200: a new shopper coupon row was written. */
    'created',
    /** 200: the code already existed for that store (dedupe, created:false), no row written. */
    'already-listed',
    /** 200: a checkout capture was listed but NOT stamped "worked": the account has no standing to vouch for a code somebody else listed (checkoutWorkedStamp.ts). */
    'worked-stamp-gated',
    /** 200: a checkout capture was listed but NOT stamped "worked": the account's daily stamp cap or the coupon's hourly velocity cap was spent. */
    'worked-stamp-capped',
    /** 401: no usable session (withRoute's gate, or a session object without a user id). */
    'unauthenticated',
    /** 403 from withRoute's origin gate: a cross-origin web page. The handler never ran. */
    'origin-not-allowed',
    /** 403 'checkout-source-extension-only' (source 'checkout' sent with a non-extension Origin) or 'manual-source-site-only' (source 'manual' sent with an extension Origin). */
    'bad-origin',
    /** 403 'capture-disabled': checkout capture is switched off (SHOPPER_CODE_CAPTURE_ENABLED). */
    'capture-disabled',
    /** 403 'consent-required': checkout without a valid accepted-consent proof (pre-1.4.9 builds). */
    'consent-required',
    /** 422 'invalid-code': the code failed normalizeShopperCode. */
    'invalid-code',
    /** 422 'not-a-store': the site is not a registrable domain, or not a store Caramel knows. */
    'not-a-store',
    /** 429 'daily-limit': the per-shopper daily submission cap. */
    'daily-limit',
    /** 429 from withRoute's 'mutation' rate-limit bucket. The handler never ran. */
    'rate-limited',
    /** 422 from withRoute's body schema (missing/invalid site, code or source). The handler never ran. */
    'invalid-body',
    /** 5xx: an unexpected error (already reported to Sentry by handleRouteError). */
    'server-error',
    /** A response none of the above explains. Seeing this means the route changed without this list. */
    'unclassified',
] as const

export type CouponSubmitOutcome = (typeof COUPON_SUBMIT_OUTCOMES)[number]

/** 'unknown' = the refusal happened before the body was read (or no usable body). */
export type CouponSubmitSource = 'checkout' | 'manual' | 'unknown'

export interface CouponSubmitOutcomeEvent {
    source: CouponSubmitSource
    outcome: CouponSubmitOutcome
    /** HTTP status the shopper/extension received. */
    status: number
    /** Registrable domain of the store, only once the route resolved one. */
    store: string | null
}

export const COUPON_SUBMIT_OUTCOME_EVENT = 'coupon_submit_outcome'

// Every submit shares one anonymous id: the event is a counter, not a
// per-person record. The shopper's identity never enters this module.
const DISTINCT_ID = 'server:coupons-submit'

/**
 * Capture one outcome event. Resolves true when PostHog accepted it. Never
 * throws; a failure is logged with context (and captureServerEvent has already
 * sent it to Sentry), and resolves false so the caller can check.
 */
export async function recordCouponSubmitOutcome(
    event: CouponSubmitOutcomeEvent,
): Promise<boolean> {
    try {
        const captured = await captureServerEvent({
            event: COUPON_SUBMIT_OUTCOME_EVENT,
            distinctId: DISTINCT_ID,
            properties: {
                outcome: event.outcome,
                submit_source: event.source,
                status: event.status,
                ...(event.store ? { store: event.store } : {}),
                $process_person_profile: false,
            },
        })
        if (!captured) {
            // false = capture disabled for this dataset, or the send failed
            // (the failure itself is already in Sentry). Say so here, with the
            // outcome, so a missing event is explained in the container log.
            console.warn(
                '[coupon-submit-outcome] event not captured (PostHog capture disabled or failed)',
                { outcome: event.outcome, source: event.source },
            )
        }
        return captured
    } catch (error) {
        console.error('[coupon-submit-outcome] capture threw', error, {
            outcome: event.outcome,
            source: event.source,
        })
        Sentry.captureException(error, {
            tags: { operation: 'coupon_submit_outcome' },
            extra: { outcome: event.outcome, source: event.source },
        })
        return false
    }
}

/**
 * Schedule the capture after the response is sent (`after()`), so a slow or
 * failing PostHog can never delay or break a submit. If `after()` itself is
 * unavailable (no request scope) the failure is logged and reported, never
 * thrown into the request path.
 */
export function scheduleCouponSubmitOutcome(
    event: CouponSubmitOutcomeEvent,
): void {
    try {
        after(() => recordCouponSubmitOutcome(event))
    } catch (error) {
        console.error(
            '[coupon-submit-outcome] could not schedule capture',
            error,
            {
                outcome: event.outcome,
                source: event.source,
            },
        )
        Sentry.captureException(error, {
            tags: { operation: 'coupon_submit_outcome_schedule' },
            extra: { outcome: event.outcome, source: event.source },
        })
    }
}
