// src/lib/couponBoxPickBudget.ts
//
// A hard ceiling on what /api/extension/coupon-box-pick can spend on the
// model — its own instance of the shared per-client + global model-call
// budget (modelCallBudget.ts carries the full why), separate from
// classify-cart's so neither route can starve the other.
//
// Sizing (2026-10-12, before launch): the extension asks only when its own
// rules could not find the coupon box, and an answer is cached for 24h per
// (store, page outline), so one shopper on one cart costs at most a few
// calls. 20 calls / 10 min per client leaves room for a shopper moving
// between several carts; 600 calls / hour globally is the same ceiling as
// classify-cart; the per-day cap (default 2000) is the hard spend ceiling the
// hourly bucket alone does not give (600 x 24 = 14400). Re-size from real traffic once the feature is switched on —
// the Sentry event the budget sends on a global trip is the signal.
import { env } from '@/lib/env'
import { createModelCallBudget } from '@/lib/modelCallBudget'

const budget = createModelCallBudget({
    label: 'coupon-box-pick',
    abuseKind: 'coupon-box-pick-model',
    perClient: { points: 20, duration: 10 * 60 }, // 20 model calls / 10 min
    global: { points: 600, duration: 60 * 60 }, // 600 model calls / hour
    // Process-wide per-day ceiling, set by COUPON_BOX_PICK_DAILY_CAP
    // (default 2000; 0 = no model calls at all, the soft kill switch — see
    // RUNBOOK.md "coupon-box pick: switch on / kill switch"). Read once at
    // boot: changing it takes a redeploy, like every env var.
    daily: { points: env.COUPON_BOX_PICK_DAILY_CAP, duration: 24 * 60 * 60 },
})

/** Admit one uncached coupon-box model call for `client`, or throw
 * ModelCallBudgetExceededError (the route answers 429). */
export const admitCouponBoxPickModelCall = budget.admit

/** Test-only reset of all buckets and the report throttles. */
export const resetCouponBoxPickBudgetForTests = budget.resetForTests

export const COUPON_BOX_PICK_BUDGET = budget.limits
