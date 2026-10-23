// src/lib/anonymousWriteQuota.ts
//
// A per-IP HOURLY quota for the two anonymous routes that write a row on
// behalf of a stranger (T-6224, T-6225): POST /api/sites/suggest and
// POST /api/sources. The shared 'mutation' bucket (30/min) lets one address
// fill the global daily caps in minutes (1000 suggestions in ~35 min, 500
// source requests in ~17 min), which would lock every honest visitor out
// until the window rolls. This quota keeps one address from spending the
// shared budget.
//
// In-memory and per process, like rateLimit.ts (single instance by design).
// TODO(T-6224): swap for a shared store if the app is ever scaled past one
// instance.
import { readClientIp } from '@/lib/clientIp'
import type { NextRequest } from 'next/server'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

const HOUR_SECONDS = 60 * 60

// Generous for a human (a handful of stores in an hour), useless for a flood.
function createQuotas() {
    return {
        'sites/suggest': new RateLimiterMemory({
            points: 10,
            duration: HOUR_SECONDS,
        }),
        sources: new RateLimiterMemory({
            points: 5,
            duration: HOUR_SECONDS,
        }),
    }
}

let quotas = createQuotas()

export type AnonymousWriteRoute = keyof ReturnType<typeof createQuotas>

export type AnonymousWriteQuota =
    | { allowed: true }
    | { allowed: false; retryAfterSec: number }

/** Spend one write from this caller's hourly quota for `route`. */
export async function consumeAnonymousWriteQuota(
    req: NextRequest,
    route: AnonymousWriteRoute,
): Promise<AnonymousWriteQuota> {
    try {
        await quotas[route].consume(readClientIp(req.headers) ?? 'unknown', 1)
        return { allowed: true }
    } catch (error) {
        // rate-limiter-flexible rejects with a RateLimiterRes once the quota
        // is spent. Anything else is a real fault and must surface, not read
        // as "over quota".
        if (error instanceof Error) throw error
        const res = error as RateLimiterRes
        return {
            allowed: false,
            retryAfterSec: Math.max(1, Math.ceil(res.msBeforeNext / 1000)),
        }
    }
}

/** Forget every counter (tests). */
export function resetAnonymousWriteQuotas(): void {
    quotas = createQuotas()
}
