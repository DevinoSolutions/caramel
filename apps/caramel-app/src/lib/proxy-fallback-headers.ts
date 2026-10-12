// src/lib/proxy-fallback-headers.ts
//
// The Devino proxy (https://proxyai.devino.ca/v1) serves free models. When the
// free route gives no answer token within N seconds (default 20) or is out of
// capacity, it can retry the request ONCE on paid OpenRouter, with an
// OpenRouter key the app sends on the request; the proxy stores no key. All
// fallback logic lives in the proxy; this module only builds the headers:
//
//   X-ORF-Fallback-Key    the app's own sk-or-v1-... key
//                         (OPENROUTER_FALLBACK_API_KEY)
//   X-ORF-Fallback-Model  optional paid OpenRouter id (OPENROUTER_FALLBACK_MODEL)
//   X-ORF-Fallback-After  optional seconds before the proxy goes paid
//                         (OPENROUTER_FALLBACK_AFTER_SECONDS)
//
// Unset key = no header, behaviour unchanged. Never sent to openrouter.ai (the
// key would leak to the upstream it already authenticates against, for no
// purpose). CI and evals run without it on purpose: the free route is the
// canary, so vitest.eval.config.ts blanks all three vars.
import { env } from '@/lib/env'

/** True when `baseUrl` is OpenRouter itself rather than the Devino proxy. */
function isOpenRouterBaseUrl(baseUrl: string): boolean {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
}

function parseFallbackAfterSeconds(
    raw: string | undefined,
): string | undefined {
    const text = raw?.trim()
    if (!text) return undefined
    const seconds = Number(text)
    return Number.isFinite(seconds) && seconds > 0 ? text : undefined
}

/** Pure: empty when there is no key or the endpoint is OpenRouter. */
export function buildProxyFallbackHeaders(input: {
    baseUrl: string
    key: string | undefined
    model: string | undefined
    afterSeconds?: string | undefined
}): Record<string, string> {
    const key = input.key?.trim()
    if (!key || isOpenRouterBaseUrl(input.baseUrl)) return {}
    const model = input.model?.trim()
    const after = parseFallbackAfterSeconds(input.afterSeconds)
    return {
        'X-ORF-Fallback-Key': key,
        ...(model ? { 'X-ORF-Fallback-Model': model } : {}),
        ...(after ? { 'X-ORF-Fallback-After': after } : {}),
    }
}

/**
 * The fallback headers for requests to `baseUrl`, read from env. `baseUrl` is
 * env.OPENROUTER_API_URL, which env.ts already pipes through z.url() (a
 * non-URL fails boot), so `new URL` above cannot throw on a request.
 */
export function proxyFallbackHeaders(baseUrl: string): Record<string, string> {
    return buildProxyFallbackHeaders({
        baseUrl,
        key: env.OPENROUTER_FALLBACK_API_KEY,
        model: env.OPENROUTER_FALLBACK_MODEL,
        afterSeconds: env.OPENROUTER_FALLBACK_AFTER_SECONDS,
    })
}
