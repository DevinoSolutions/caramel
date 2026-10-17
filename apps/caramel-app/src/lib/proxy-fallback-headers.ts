/**
 * Paid-fallback headers for the Devino proxy.
 *
 * The proxy (https://proxyai.devino.ca/v1) serves free models. When the free
 * route gives no answer token within `X-ORF-Fallback-After` seconds, or is out
 * of capacity, it retries the request once on paid OpenRouter with the key
 * this app sends in `X-ORF-Fallback-Key`. The proxy stores no key; this module
 * only builds the request headers.
 *
 * - Unset or blank key: no headers, behaviour unchanged.
 * - The key goes ONLY to https://proxyai.devino.ca (allowlist), never to
 *   openrouter.ai, another gateway, or plain http.
 * - A malformed value never breaks a request: it is treated as unset here, and
 *   the env schema refuses it at boot (`isValidFallbackKey` & co).
 * - Guests, evals and CI never carry the key.
 *
 * Canonical copy: keep this file identical in every Devino app. It is pure (no
 * env import) so the env schema can import its predicates without a cycle; the
 * env read lives in `proxy-fallback-env.ts`.
 */

/** The only hosts that may receive the app's paid OpenRouter key. */
const PAID_FALLBACK_HOSTS: ReadonlySet<string> = new Set(['proxyai.devino.ca'])

/** Seconds the proxy waits on the free route before going paid. */
export const DEFAULT_FALLBACK_AFTER_SECONDS = '8'

const FALLBACK_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9]{20,}$/
const FALLBACK_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/
const PLAIN_DECIMAL_PATTERN = /^\d+(\.\d+)?$/

/**
 * Longest wait an app may configure. A call path only carries the headers when
 * its client deadline is at least this plus `PAID_ANSWER_SECONDS`, so the paid
 * answer still lands inside the deadline.
 */
export const MAX_FALLBACK_AFTER_SECONDS = 12

/** Time a paid answer needs after the proxy switches to it. */
export const PAID_ANSWER_SECONDS = 8

/** Shortest client deadline, in seconds, of a call path that may carry the headers. */
export const MIN_PAID_PATH_DEADLINE_SECONDS =
    MAX_FALLBACK_AFTER_SECONDS + PAID_ANSWER_SECONDS

/** True only for https://proxyai.devino.ca (any path, any case, trailing dot tolerated). */
export function isDevinoProxyUrl(baseUrl: string | undefined): boolean {
    if (!baseUrl) return false
    let url: URL
    try {
        url = new URL(baseUrl)
    } catch {
        return false
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return url.protocol === 'https:' && PAID_FALLBACK_HOSTS.has(host)
}

/** The canonical seconds string, or undefined unless a plain decimal in (0, 12]. */
export function parseFallbackAfterSeconds(
    raw: string | undefined,
): string | undefined {
    const text = raw?.trim()
    if (!text || !PLAIN_DECIMAL_PATTERN.test(text)) return undefined
    const seconds = Number(text)
    return seconds > 0 && seconds <= MAX_FALLBACK_AFTER_SECONDS
        ? String(seconds)
        : undefined
}

/** Env-schema check: blank/unset, or an OpenRouter `sk-or-v1-` key. */
export function isValidFallbackKey(raw: string | undefined): boolean {
    const text = raw?.trim()
    return !text || FALLBACK_KEY_PATTERN.test(text)
}

/** Env-schema check: blank/unset, or an OpenRouter model id like `vendor/model`. */
export function isValidFallbackModel(raw: string | undefined): boolean {
    const text = raw?.trim()
    return !text || FALLBACK_MODEL_PATTERN.test(text)
}

/** Env-schema check: blank/unset, or a plain decimal in (0, 12]. */
export function isValidFallbackAfterSeconds(raw: string | undefined): boolean {
    return !raw?.trim() || parseFallbackAfterSeconds(raw) !== undefined
}

/**
 * `fetch` for every client that sends the fallback headers: a redirect fails
 * instead of following, because fetch only strips `Authorization` and cookies
 * on a cross-origin redirect and would forward `X-ORF-Fallback-Key`.
 */
export function fetchWithoutRedirects(
    input: string | URL | Request,
    init?: RequestInit,
): Promise<Response> {
    return fetch(input, { ...init, redirect: 'error' })
}

/** Pure: the fallback headers, or `{}` without a valid key or off the Devino proxy. */
export function buildProxyFallbackHeaders(input: {
    baseUrl: string | undefined
    key: string | undefined
    model: string | undefined
    afterSeconds: string | undefined
}): Record<string, string> {
    const key = input.key?.trim()
    if (
        !key ||
        !FALLBACK_KEY_PATTERN.test(key) ||
        !isDevinoProxyUrl(input.baseUrl)
    )
        return {}
    const model = input.model?.trim()
    return {
        'X-ORF-Fallback-Key': key,
        'X-ORF-Fallback-After':
            parseFallbackAfterSeconds(input.afterSeconds) ??
            DEFAULT_FALLBACK_AFTER_SECONDS,
        ...(model && FALLBACK_MODEL_PATTERN.test(model)
            ? { 'X-ORF-Fallback-Model': model }
            : {}),
    }
}
