// src/lib/modelCallBudget.ts
//
// A hard ceiling on what one anonymous, extension-only LLM route can spend on
// the model. Each such route makes its own budget from this factory
// (classifyCartModelBudget.ts for /api/classify-cart, couponBoxPickBudget.ts
// for /api/extension/coupon-box-pick), so the routes never share a bucket and
// one route's traffic cannot starve the other.
//
// Why: these routes are anonymous by design and their only gate is
// `origin: 'extension'`, which a browser enforces but any HTTP client can
// forge with one header (security report 2026-10, verified live on prod:
// `Origin: chrome-extension://<any>` reached the model). The route's generic
// per-IP rate limit bounds one client, but per-IP buckets don't bound SPEND:
// an IP-rotating sender gets a fresh bucket per address, and any path that
// reaches the origin without Cloudflare can pick its own CF-Connecting-IP. So
// a budget meters the one thing that costs money — an UNCACHED model call —
// at two levels:
//
//   * per client: a tighter bucket than the route's, counting model calls
//     only (cache hits stay free and unmetered);
//   * global: a fixed ceiling for the whole process, the bound that holds no
//     matter how many addresses a sender controls.
//
// In-memory, like rateLimit.ts and the answer caches: correct for the ONE web
// instance the root compose runs. TODO: move to a shared store if the app is
// ever scaled past one instance (each instance would get its own ceiling).
import { reportRateLimitRejection } from '@/lib/abuseSignal'
import * as Sentry from '@sentry/nextjs'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

export type ModelBudgetScope = 'client' | 'global'

/** Thrown by a budget's `admit` when a model call would exceed it. The route
 * turns it into a 429; the extension treats any non-2xx from these routes as
 * "no answer" and carries on. */
export class ModelCallBudgetExceededError extends Error {
    constructor(
        readonly budgetLabel: string,
        readonly scope: ModelBudgetScope,
        readonly retryAfterSec: number,
    ) {
        super(`${budgetLabel} model-call budget exceeded (${scope})`)
        this.name = 'ModelCallBudgetExceededError'
    }
}

interface BucketSize {
    /** Model calls allowed per window. */
    points: number
    /** Window length in seconds. */
    duration: number
}

export interface ModelCallBudgetConfig {
    /** Names the route in the error message, the Sentry event and the global
     * bucket key (e.g. 'classify-cart'). */
    label: string
    /** `kind` handed to abuseSignal on a per-client trip. */
    abuseKind: string
    perClient: BucketSize
    global: BucketSize
    /** Builds the refusal. Defaults to a plain ModelCallBudgetExceededError;
     * a route that already exports its own subclass passes it here. */
    createError?: (
        scope: ModelBudgetScope,
        retryAfterSec: number,
    ) => ModelCallBudgetExceededError
}

export interface ModelCallBudgetClient {
    ip: string
    path: string
    userAgent: string
}

export interface ModelCallBudget {
    /**
     * Admit one uncached model call for `client`, or throw the budget's
     * ModelCallBudgetExceededError. Call it AFTER the answer cache missed and
     * BEFORE the model is called — a cache hit must never spend budget.
     */
    admit(client: ModelCallBudgetClient): Promise<void>
    /** Test-only reset of both buckets and the report throttle. */
    resetForTests(): void
    readonly limits: { readonly perClient: number; readonly global: number }
}

function retryAfterOf(res: RateLimiterRes): number {
    return Math.max(1, Math.ceil(res.msBeforeNext / 1000))
}

export function createModelCallBudget(
    config: ModelCallBudgetConfig,
): ModelCallBudget {
    const globalKey = `${config.label}:model-calls`
    const createError =
        config.createError ??
        ((scope, retryAfterSec) =>
            new ModelCallBudgetExceededError(
                config.label,
                scope,
                retryAfterSec,
            ))

    let perClientLimiter = new RateLimiterMemory(config.perClient)
    let globalLimiter = new RateLimiterMemory(config.global)
    /** A sustained flood is ONE Sentry event per global window, not one per
     * request: after reporting, stay quiet until the current window ends. */
    let nextGlobalTripReportAt = 0

    async function admit(client: ModelCallBudgetClient): Promise<void> {
        try {
            await perClientLimiter.consume(client.ip, 1)
        } catch (rejection) {
            const retryAfterSec = retryAfterOf(rejection as RateLimiterRes)
            void reportRateLimitRejection({
                ip: client.ip,
                path: client.path,
                kind: config.abuseKind,
                userAgent: client.userAgent,
                retryAfterSec,
            })
            throw createError('client', retryAfterSec)
        }

        try {
            await globalLimiter.consume(globalKey, 1)
        } catch (rejection) {
            const res = rejection as RateLimiterRes
            const retryAfterSec = retryAfterOf(res)
            if (Date.now() >= nextGlobalTripReportAt) {
                nextGlobalTripReportAt = Date.now() + res.msBeforeNext
                Sentry.captureMessage(
                    `${config.label} global model-call budget exhausted`,
                    {
                        level: 'warning',
                        tags: { route: config.label, budget: 'global' },
                        extra: {
                            ceiling: config.global.points,
                            windowSeconds: config.global.duration,
                            retryAfterSec,
                            lastClientIp: client.ip,
                        },
                    },
                )
            }
            // Intentional: during a global trip the per-client bucket no longer
            // fills (refunded below), so the per-IP abuse signal won't fire; the
            // global Sentry event above is the signal instead.
            // The client's point was spent on a call that never reached the
            // model: give it back, so a global refusal (which the client cannot
            // cause or avoid) does not also eat into its own per-client budget.
            await perClientLimiter.reward(client.ip, 1)
            throw createError('global', retryAfterSec)
        }
    }

    return {
        admit,
        resetForTests() {
            perClientLimiter = new RateLimiterMemory(config.perClient)
            globalLimiter = new RateLimiterMemory(config.global)
            nextGlobalTripReportAt = 0
        },
        limits: {
            perClient: config.perClient.points,
            global: config.global.points,
        },
    }
}
