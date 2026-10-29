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

// Caramel: the coupon-box pick (src/lib/couponBoxPick.ts) is the one caller,
// approved by Aladdin 2026-10-23 for that guest-reachable route behind its
// daily model-call cap and the key's own weekly limit. classify-cart sends
// none. A caller needs a deadline of at least MIN_PAID_PATH_DEADLINE_SECONDS
// and a request that follows no redirect (chat() does both for the box pick).

let warnedOffProxy = false

/** The fallback headers for a request to `baseUrl` (no key or off the proxy: none). */
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
