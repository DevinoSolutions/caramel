const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini'

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
    const key = process.env.OPENROUTER_API_KEY
    if (!key) throw new OpenRouterError('OPENROUTER_API_KEY not set')

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
            choices?: { message?: { content?: string } }[]
        }
        const content = json?.choices?.[0]?.message?.content
        if (typeof content !== 'string')
            throw new OpenRouterError('empty response')
        return content
    } finally {
        clearTimeout(timeout)
    }
}
