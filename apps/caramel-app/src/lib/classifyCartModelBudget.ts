// src/lib/classifyCartModelBudget.ts
//
// A hard ceiling on what /api/classify-cart can spend on the model.
//
// Why: the route is anonymous by design (guests get the "may not apply — your
// cart is X" hint too), and its only gate is `origin: 'extension'`, which a
// browser enforces but any HTTP client can forge with one header (security
// report 2026-10, verified live on prod: `Origin: chrome-extension://<any>`
// reached the model and returned a classification). The route's generic
// per-IP `mutation` limit bounds one client, but per-IP buckets don't bound
// SPEND: an IP-rotating sender gets a fresh bucket per address, and any path
// that reaches the origin without Cloudflare can pick its own
// CF-Connecting-IP. So this module meters the one thing that costs money —
// an UNCACHED model call — at two levels:
//
//   * per client: a tighter bucket than the route's, counting model calls
//     only (cache hits stay free and unmetered);
//   * global: a fixed ceiling for the whole process, the bound that holds no
//     matter how many addresses a sender controls.
//
// Sizing (2026-10-09): Sentry holds ~330 classify-cart transactions for the
// previous 30 days at the server's 5% trace sample rate (sentry.common.config
// .ts) — so ~6,600-6,800 real requests, ~10/hour on average, and that count
// includes cache hits, which never reach this budget. The global ceiling of
// 600 PAID calls/hour is ~60x that average, so it should never trip for real
// shoppers, while capping the worst case at 600 gpt-5-mini calls/hour. Raise
// it here if organic traffic approaches it — the Sentry event below is the
// signal that it has.
//
// In-memory, like rateLimit.ts and the classifier cache: correct for the ONE
// web instance the root compose runs. TODO: move to a shared store if the app
// is ever scaled past one instance (each instance would get its own ceiling).
import { reportRateLimitRejection } from '@/lib/abuseSignal'
import * as Sentry from '@sentry/nextjs'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

const PER_CLIENT = { points: 20, duration: 10 * 60 } // 20 model calls / 10 min
const GLOBAL = { points: 600, duration: 60 * 60 } // 600 model calls / hour
const GLOBAL_KEY = 'classify-cart:model-calls'

let perClientLimiter = new RateLimiterMemory(PER_CLIENT)
let globalLimiter = new RateLimiterMemory(GLOBAL)
/** A sustained flood is ONE Sentry event per global window, not one per
 * request: after reporting, stay quiet until the current window ends. */
let nextGlobalTripReportAt = 0

/** Thrown by admitClassifyModelCall when a model call would exceed a budget.
 * The route turns it into a 429; the extension already treats any non-2xx
 * from classify-cart as "no hint" and carries on. */
export class ClassifyModelBudgetExceededError extends Error {
    constructor(
        readonly scope: 'client' | 'global',
        readonly retryAfterSec: number,
    ) {
        super(`classify-cart model-call budget exceeded (${scope})`)
        this.name = 'ClassifyModelBudgetExceededError'
    }
}

function retryAfterOf(res: RateLimiterRes): number {
    return Math.max(1, Math.ceil(res.msBeforeNext / 1000))
}

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
    try {
        await perClientLimiter.consume(client.ip, 1)
    } catch (rejection) {
        const retryAfterSec = retryAfterOf(rejection as RateLimiterRes)
        void reportRateLimitRejection({
            ip: client.ip,
            path: client.path,
            kind: 'classify-model',
            userAgent: client.userAgent,
            retryAfterSec,
        })
        throw new ClassifyModelBudgetExceededError('client', retryAfterSec)
    }

    try {
        await globalLimiter.consume(GLOBAL_KEY, 1)
    } catch (rejection) {
        const res = rejection as RateLimiterRes
        const retryAfterSec = retryAfterOf(res)
        if (Date.now() >= nextGlobalTripReportAt) {
            nextGlobalTripReportAt = Date.now() + res.msBeforeNext
            Sentry.captureMessage(
                'classify-cart global model-call budget exhausted',
                {
                    level: 'warning',
                    tags: { route: 'classify-cart', budget: 'global' },
                    extra: {
                        ceiling: GLOBAL.points,
                        windowSeconds: GLOBAL.duration,
                        retryAfterSec,
                        lastClientIp: client.ip,
                    },
                },
            )
        }
        throw new ClassifyModelBudgetExceededError('global', retryAfterSec)
    }
}

/** Test-only reset of both buckets and the report throttle. */
export function resetClassifyModelBudgetForTests(): void {
    perClientLimiter = new RateLimiterMemory(PER_CLIENT)
    globalLimiter = new RateLimiterMemory(GLOBAL)
    nextGlobalTripReportAt = 0
}

export const CLASSIFY_MODEL_BUDGET = {
    perClient: PER_CLIENT.points,
    global: GLOBAL.points,
} as const
