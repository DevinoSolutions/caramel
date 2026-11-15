import { fastFailFetch, isAiUnavailableError } from '@/lib/ai-fast-fail'
import { env } from '@/lib/env'
import {
    fetchWithoutRedirects,
    isDevinoProxyUrl,
} from '@/lib/proxy-fallback-headers'
import * as Sentry from '@sentry/nextjs'

const DEFAULT_MODEL = env.OPENROUTER_MODEL

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface ChatOptions {
    model?: string
    temperature?: number
    maxTokens?: number
    responseFormat?: 'json_object' | 'text'
    timeoutMs?: number
    /** How long a reasoning model may think before answering. Sent only when
     * set, so every existing caller's request body is unchanged. */
    reasoningEffort?: 'low' | 'medium' | 'high'
    /** Extra request headers for this call only (none by default, so every
     * existing caller sends exactly the headers it always did). Merged
     * UNDER the fixed headers below: a caller can add a header but never
     * replace Content-Type, Authorization, HTTP-Referer, X-Title or
     * X-Request-Id. */
    headers?: Record<string, string>
}

export class OpenRouterError extends Error {
    status?: number
    /** True when the call was aborted by its own timeout (a slow upstream, not
     * a defect here); lets callers report it as a warning, not an error. */
    readonly timedOut: boolean
    /** The underlying error (the tsconfig lib predates ES2022 `Error.cause`). */
    readonly cause?: unknown
    constructor(
        message: string,
        status?: number,
        options: { timedOut?: boolean; cause?: unknown } = {},
    ) {
        super(message)
        this.name = 'OpenRouterError'
        this.status = status
        this.timedOut = options.timedOut ?? false
        this.cause = options.cause
    }
}

/**
 * Fast-fail bounds for a call through the Devino proxy (T-17816, rule C4g).
 * Every chat() call is non-streamed, so the canonical non-streamed bounds
 * apply (50 s first byte, 55 s for all attempts: the proxy holds a
 * non-streamed reply up to 40 s before committing it), each capped at the
 * caller's own timeoutMs, which stays the real budget of the call.
 */
export const NON_STREAMED_FIRST_BYTE_MS = 50_000
export const NON_STREAMED_DEADLINE_MS = 55_000

/** The global fetch, read at call time, that never follows a redirect. */
const noRedirectFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, redirect: 'error' })

/**
 * How one chat() call is sent.
 *
 * On the Devino proxy: fast-fail (ai-fast-fail.ts, the fleet copy). A dropped
 * connection, a first-byte timeout or a 429/502/503/504 is retried at most
 * twice, only while the call's budget leaves room; the paid-fallback headers
 * ride the first attempt only; and no attempt follows a redirect, which would
 * hand the key (and the paid key) to whatever host it names. That replaces
 * fetchWithoutRedirects there, whose connect-only retry fast-fail covers.
 *
 * Anywhere else (OpenRouter direct): exactly what it was. One attempt; with
 * the paid key, no redirect followed.
 */
function sendFor(timeoutMs: number, carriesFallbackKey: boolean): typeof fetch {
    if (isDevinoProxyUrl(env.OPENROUTER_API_URL)) {
        return fastFailFetch(noRedirectFetch, {
            firstByteMs: Math.min(NON_STREAMED_FIRST_BYTE_MS, timeoutMs),
            deadlineMs: Math.min(NON_STREAMED_DEADLINE_MS, timeoutMs),
        })
    }
    return carriesFallbackKey ? fetchWithoutRedirects : fetch
}

export async function chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
): Promise<string> {
    const key = env.OPENROUTER_API_KEY
    if (!key) throw new OpenRouterError('OPENROUTER_API_KEY not set')

    // F-011 — coarse cross-hop trace correlation. Sentry already spans this
    // fetch and propagates sentry-trace/baggage (nativeNodeFetchIntegration,
    // on by default — see PLAN-F-011.md), but OpenRouter neither reads nor
    // returns those headers, so that propagation is a dead end. The useful
    // correlation is manual: a request id we control (sent as a header,
    // ignored by OpenRouter, but usable if we ever log outgoing requests)
    // plus OpenRouter's own response `id` (the generation id visible in
    // their dashboard) — both stashed on the active span below.
    const requestId = crypto.randomUUID()

    const timeoutMs = opts.timeoutMs ?? 8000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const body: Record<string, unknown> = {
            model: opts.model || DEFAULT_MODEL,
            messages,
            temperature: opts.temperature ?? 0,
            max_tokens: opts.maxTokens ?? 200,
        }
        if (opts.responseFormat === 'json_object') {
            body.response_format = { type: 'json_object' }
        }
        if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

        // env.OPENROUTER_API_URL defaults to https://openrouter.ai/api/v1 (no
        // trailing slash), so with it unset this is exactly the URL this file
        // used to hardcode; set, it points at an OpenAI-compatible relay such
        // as the Devino proxy (https://proxyai.devino.ca/v1).
        // A request carrying the paid-fallback key follows no redirect: fetch
        // strips only Authorization and cookies on a cross-origin redirect,
        // so a plain fetch would hand X-ORF-Fallback-Key to the new host.
        const carriesFallbackKey = Object.keys(opts.headers ?? {}).some(
            name => name.toLowerCase() === 'x-orf-fallback-key',
        )
        const send = sendFor(timeoutMs, carriesFallbackKey)
        const res = await send(`${env.OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                ...opts.headers,
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
                'HTTP-Referer': 'https://caramel.app',
                'X-Title': 'Caramel Extension',
                'X-Request-Id': requestId,
            },
            body: JSON.stringify(body),
        }).catch((error: unknown) => {
            // Fast-fail gave up (the proxy stayed unreachable, or sent no reply
            // headers within the budget): the same OpenRouterError a failed
            // status is, with timedOut set so the callers report a slow
            // upstream as a warning, as they do for their own abort.
            if (isAiUnavailableError(error)) {
                throw new OpenRouterError(
                    `openrouter unavailable: ${error.detail}`,
                    error.status,
                    { timedOut: error.kind === 'timeout', cause: error },
                )
            }
            throw error
        })
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new OpenRouterError(
                `openrouter ${res.status}: ${detail.slice(0, 200)}`,
                res.status,
            )
        }
        const json = (await res.json()) as {
            id?: string
            choices?: { message?: { content?: string } }[]
        }

        // No-op outside prod: Sentry.init only runs there (see
        // sentry.common.config.ts), so getActiveSpan() is always undefined
        // in dev/test.
        Sentry.getActiveSpan()?.setAttributes({
            'openrouter.request_id': requestId,
            ...(typeof json?.id === 'string'
                ? { 'openrouter.generation_id': json.id }
                : {}),
        })

        const content = json?.choices?.[0]?.message?.content
        if (typeof content !== 'string')
            throw new OpenRouterError('empty response')
        return content
    } finally {
        clearTimeout(timeout)
    }
}
