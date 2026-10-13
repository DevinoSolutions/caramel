/**
 * Reads this app's paid-fallback env for `proxy-fallback-headers.ts`. Kept apart
 * from the pure helper so the env schema can import the helper's predicates
 * without an import cycle.
 *
 * Canonical copy: identical in every Devino app except the env import line.
 */
import { env } from '@/lib/env'
import { buildProxyFallbackHeaders } from './proxy-fallback-headers'

/** The fallback headers for a signed-in user's request to `baseUrl`. */
export function proxyFallbackHeaders(
    baseUrl: string | undefined,
): Record<string, string> {
    return buildProxyFallbackHeaders({
        baseUrl,
        key: env.OPENROUTER_FALLBACK_API_KEY,
        model: env.OPENROUTER_FALLBACK_MODEL,
        afterSeconds: env.OPENROUTER_FALLBACK_AFTER_SECONDS,
    })
}
