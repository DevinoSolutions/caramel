// src/lib/analytics/couponBoxPickOutcome.ts
//
// One server-side PostHog event per POST /api/extension/coupon-box-pick
// request that reaches the handler, naming what the route DID with it and how
// long it took.
//
// Why: the pick is a paid, LLM-backed route that is switched on by env. Its
// non-200 and `no_pick` answers are expected (the extension carries on as if
// the rules found nothing) and do not reach Sentry, so without this event
// "the model is slow", "the model keeps failing", "the daily cap is tripping"
// and "nobody needs a pick" look identical. This makes each a query.
//
// NOT covered: requests withRoute refuses BEFORE the handler runs (the
// extension-Origin gate's 403, the 'mutation' rate limit's 429) emit nothing.
// Those are cheap, never reach the model, and the rate limiter already
// reports abuse on its own.
//
// Read it in PostHog: event `coupon_box_pick_outcome`, break down by
// `outcome`; RUNBOOK.md "coupon-box pick: switch on / kill switch" has the
// HogQL for the outcome mix and p50/p95 latency.
//
// No PII, by construction: no IP, user id, user agent or outline text. A
// constant distinct id with `$process_person_profile: false` (no person is
// minted). The only free-form value is the store's domain, and only once the
// route has parsed and validated the request.
import * as Sentry from '@sentry/nextjs'
import { after } from 'next/server'
import { captureServerEvent } from './posthogServer'

/**
 * Every way a request that reached the coupon-box-pick handler can end.
 * Exactly one per request.
 */
export const COUPON_BOX_PICK_OUTCOMES = [
    /** 200: the model found the coupon input and/or a toggle that reveals it. */
    'box',
    /** 200: the model answered that the page has no coupon box. */
    'no_box',
    /** 200 no_pick: COUPON_BOX_LLM_ENABLED is off or no model is configured (body never read). */
    'no_pick:disabled',
    /** 200 no_pick: the model call threw or timed out (already in Sentry). */
    'no_pick:model_error',
    /** 200 no_pick: the model replied with something unusable (already in Sentry). */
    'no_pick:unparsable',
    /** 200 no_pick: the model named an apply button the server refuses (an order, pay or rewards control), so the answer is not used. */
    'no_pick:refused_button',
    /** 429: the per-client model-call bucket (20 / 10 min). */
    'budget_exceeded:client',
    /** 429: the process-wide hourly model-call bucket (600 / hour). */
    'budget_exceeded:global',
    /** 429: the per-day cap (COUPON_BOX_PICK_DAILY_CAP; 0 = kill switch). */
    'budget_exceeded:daily',
    /** 413: the body or the outline is over its size cap. */
    'too_large',
    /** 400: the body is not JSON or does not match the request schema. */
    'invalid',
    /** 5xx: an unexpected error (already reported to Sentry by handleRouteError). */
    'server_error',
] as const

export type CouponBoxPickOutcome = (typeof COUPON_BOX_PICK_OUTCOMES)[number]

export interface CouponBoxPickOutcomeEvent {
    outcome: CouponBoxPickOutcome
    /** Answer-cache hit or miss; null when the request never got that far. */
    cached: boolean | null
    /** Whole-request wall time inside the handler, in ms. */
    latencyMs: number
    /** Time spent in pickCouponBox for a request that made a model call, else null. */
    modelMs: number | null
    /** The request's domain, only once parsed and valid. */
    store: string | null
    /** The configured model name (COUPON_BOX_PICK_MODEL), when one is set. */
    model: string | null
}

export const COUPON_BOX_PICK_OUTCOME_EVENT = 'coupon_box_pick_outcome'

// Every request shares one anonymous id: the event is a counter, not a
// per-person record. No caller identity enters this module.
const DISTINCT_ID = 'server:coupon-box-pick'

/**
 * Capture one outcome event. Resolves true when PostHog accepted it. Never
 * throws; a failure is logged with context (and captureServerEvent has already
 * sent it to Sentry), and resolves false so the caller can check.
 */
export async function recordCouponBoxPickOutcome(
    event: CouponBoxPickOutcomeEvent,
): Promise<boolean> {
    try {
        const captured = await captureServerEvent({
            event: COUPON_BOX_PICK_OUTCOME_EVENT,
            distinctId: DISTINCT_ID,
            properties: {
                outcome: event.outcome,
                latency_ms: Math.round(event.latencyMs),
                ...(event.cached === null ? {} : { cached: event.cached }),
                ...(event.modelMs === null
                    ? {}
                    : { model_ms: Math.round(event.modelMs) }),
                ...(event.store ? { store: event.store } : {}),
                ...(event.model ? { model: event.model } : {}),
                $process_person_profile: false,
            },
        })
        if (!captured) {
            // false = capture disabled for this dataset, or the send failed
            // (the failure itself is already in Sentry). Say so here, with the
            // outcome, so a missing event is explained in the container log.
            console.warn(
                '[coupon-box-pick-outcome] event not captured (PostHog capture disabled or failed)',
                { outcome: event.outcome },
            )
        }
        return captured
    } catch (error) {
        console.error('[coupon-box-pick-outcome] capture threw', error, {
            outcome: event.outcome,
        })
        Sentry.captureException(error, {
            tags: { operation: 'coupon_box_pick_outcome' },
            extra: { outcome: event.outcome },
        })
        return false
    }
}

/**
 * Schedule the capture after the response is sent (`after()`), so a slow or
 * failing PostHog can never delay or break a pick. If `after()` itself is
 * unavailable (no request scope) the failure is logged and reported, never
 * thrown into the request path.
 */
export function scheduleCouponBoxPickOutcome(
    event: CouponBoxPickOutcomeEvent,
): void {
    try {
        after(() => recordCouponBoxPickOutcome(event))
    } catch (error) {
        console.error(
            '[coupon-box-pick-outcome] could not schedule capture',
            error,
            { outcome: event.outcome },
        )
        Sentry.captureException(error, {
            tags: { operation: 'coupon_box_pick_outcome_schedule' },
            extra: { outcome: event.outcome },
        })
    }
}
