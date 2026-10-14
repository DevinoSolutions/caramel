// src/lib/classifyCartModelBudget.ts
//
// A hard ceiling on what /api/classify-cart can spend on the model — one
// instance of the shared per-client + global model-call budget
// (modelCallBudget.ts, which carries the full why: the route is anonymous by
// design, `origin: 'extension'` is forgeable, and per-IP buckets alone do not
// bound spend).
//
// Sizing (2026-10-09): Sentry holds ~330 classify-cart transactions for the
// previous 30 days at the server's 5% trace sample rate (sentry.common.config
// .ts) — so ~6,600-6,800 real requests, ~10/hour on average, and that count
// includes cache hits, which never reach this budget. The global ceiling of
// 600 PAID calls/hour is ~60x that average, so it should never trip for real
// shoppers, while capping the worst case at 600 gpt-5-mini calls/hour. Raise
// it here if organic traffic approaches it — the Sentry event the budget
// sends on a global trip is the signal that it has.
import {
    createModelCallBudget,
    ModelCallBudgetExceededError,
    type ModelBudgetScope,
} from '@/lib/modelCallBudget'

const PER_CLIENT = { points: 20, duration: 10 * 60 } // 20 model calls / 10 min
const GLOBAL = { points: 600, duration: 60 * 60 } // 600 model calls / hour

/** Thrown by admitClassifyModelCall when a model call would exceed a budget.
 * The route turns it into a 429; the extension already treats any non-2xx
 * from classify-cart as "no hint" and carries on. */
export class ClassifyModelBudgetExceededError extends ModelCallBudgetExceededError {
    constructor(scope: ModelBudgetScope, retryAfterSec: number) {
        super('classify-cart', scope, retryAfterSec)
        this.name = 'ClassifyModelBudgetExceededError'
    }
}

const budget = createModelCallBudget({
    label: 'classify-cart',
    abuseKind: 'classify-model',
    perClient: PER_CLIENT,
    global: GLOBAL,
    createError: (scope, retryAfterSec) =>
        new ClassifyModelBudgetExceededError(scope, retryAfterSec),
})

/**
 * Admit one uncached model call for `client`, or throw
 * ClassifyModelBudgetExceededError. Call it AFTER the classifier's cache
 * missed and BEFORE the model is called — a cache hit must never spend budget.
 */
export async function admitClassifyModelCall(client: {
    ip: string
    path: string
    userAgent: string
}): Promise<void> {
    await budget.admit(client)
}

/** Test-only reset of both buckets and the report throttle. */
export function resetClassifyModelBudgetForTests(): void {
    budget.resetForTests()
}

export const CLASSIFY_MODEL_BUDGET = {
    perClient: PER_CLIENT.points,
    global: GLOBAL.points,
} as const
