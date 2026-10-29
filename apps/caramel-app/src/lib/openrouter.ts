import { env } from '@/lib/env'
import { fetchWithoutRedirects } from '@/lib/proxy-fallback-headers'
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

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)
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
        const send = carriesFallbackKey ? fetchWithoutRedirects : fetch
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
