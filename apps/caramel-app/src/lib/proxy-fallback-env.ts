/**
 * Reads this app's paid-fallback env for `proxy-fallback-headers.ts`. Kept apart
 * from the pure helper so the env schema can import the helper's predicates
 * without an import cycle.
 *
 * Canonical copy: identical in every Devino app except the env import line.
 */
import { env } from '@/lib/env'
import {
    buildProxyFallbackHeaders,
    isDevinoProxyUrl,
} from './proxy-fallback-headers'

// Caramel: no production caller sends these headers today. Both LLM routes
// (classify-cart, coupon-box-pick) are guest-reachable, and guests never get
// the paid path. Kept because every Devino app carries this reader; a future
// signed-in caller with a deadline of at least MIN_PAID_PATH_DEADLINE_SECONDS
// wires in here, with fetchWithoutRedirects on its request.

let warnedOffProxy = false

/** The fallback headers for a signed-in user's request to `baseUrl`. */
export function proxyFallbackHeaders(
    baseUrl: string | undefined,
): Record<string, string> {
    if (
        !warnedOffProxy &&
        env.OPENROUTER_FALLBACK_API_KEY?.trim() &&
        !isDevinoProxyUrl(baseUrl)
    ) {
        // A key that can never be sent should not stay invisible; the value is never logged.
        warnedOffProxy = true
        console.warn(
            'OPENROUTER_FALLBACK_API_KEY is set but the AI base URL is not https://proxyai.devino.ca, so no paid fallback is sent.',
        )
    }
    return buildProxyFallbackHeaders({
        baseUrl,
        key: env.OPENROUTER_FALLBACK_API_KEY,
        model: env.OPENROUTER_FALLBACK_MODEL,
        afterSeconds: env.OPENROUTER_FALLBACK_AFTER_SECONDS,
    })
}
