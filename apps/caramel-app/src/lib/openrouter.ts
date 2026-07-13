import { env } from '@/lib/env'
import * as Sentry from '@sentry/nextjs'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
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
}

export class OpenRouterError extends Error {
    status?: number
    constructor(message: string, status?: number) {
        super(message)
        this.name = 'OpenRouterError'
        this.status = status
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

        const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
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
