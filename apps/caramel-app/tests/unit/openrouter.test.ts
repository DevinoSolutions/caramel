import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-011 — pins the current OpenRouter fetch contract (URL, method, headers,
// body, success/error parsing) BEFORE adding trace-correlation (X-Request-Id
// header + Sentry span attributes for the coarse cross-hop correlation this
// finding asks for — see PLAN-F-011.md §Approach "Trace correlation"). Proves
// the correlation edit doesn't regress the existing OpenRouter contract.
const { envMock } = vi.hoisted(() => ({
    envMock: {
        OPENROUTER_API_KEY: 'test-openrouter-key' as string | undefined,
        OPENROUTER_MODEL: 'openai/gpt-5-mini',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

// Two separate vi.hoisted calls (rather than one returning both) so
// getActiveSpanMock's factory can close over setAttributesMock without a
// same-named local shadowing the outer destructured binding.
const setAttributesMock = vi.hoisted(() => vi.fn())
const getActiveSpanMock = vi.hoisted(() =>
    vi.fn((): { setAttributes: typeof setAttributesMock } | undefined => ({
        setAttributes: setAttributesMock,
    })),
)
vi.mock('@sentry/nextjs', () => ({ getActiveSpan: getActiveSpanMock }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { chat, OpenRouterError } from '@/lib/openrouter'

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

beforeEach(() => {
    fetchMock.mockReset()
    setAttributesMock.mockClear()
    getActiveSpanMock.mockClear()
    getActiveSpanMock.mockImplementation(() => ({
        setAttributes: setAttributesMock,
    }))
    envMock.OPENROUTER_API_KEY = 'test-openrouter-key'
    envMock.OPENROUTER_MODEL = 'openai/gpt-5-mini'
})

describe('chat() — OpenRouter fetch contract (F-011 pin)', () => {
    it('throws immediately when OPENROUTER_API_KEY is unset (no fetch attempted)', async () => {
        envMock.OPENROUTER_API_KEY = undefined
        await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            'OPENROUTER_API_KEY not set',
        )
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('POSTs to the chat completions URL with Authorization/HTTP-Referer/X-Title headers and the expected JSON body', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: 'hello' } }] }),
        )

        const result = await chat([{ role: 'user', content: 'hi' }], {
            temperature: 0.2,
            maxTokens: 50,
        })

        expect(result).toBe('hello')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
        expect(init.method).toBe('POST')

        const headers = init.headers as Record<string, string>
        expect(headers['Content-Type']).toBe('application/json')
        expect(headers['Authorization']).toBe('Bearer test-openrouter-key')
        expect(headers['HTTP-Referer']).toBe('https://caramel.app')
        expect(headers['X-Title']).toBe('Caramel Extension')
        expect(headers['X-Request-Id']).toEqual(expect.any(String))
        expect(headers['X-Request-Id'].length).toBeGreaterThan(0)

        const body = JSON.parse(init.body as string)
        expect(body).toEqual({
            model: 'openai/gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.2,
            max_tokens: 50,
        })
    })

    it('defaults model/temperature/max_tokens and omits response_format when not requested', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await chat([{ role: 'user', content: 'hi' }])
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        const body = JSON.parse(init.body as string)
        expect(body.model).toBe('openai/gpt-5-mini')
        expect(body.temperature).toBe(0)
        expect(body.max_tokens).toBe(200)
        expect(body.response_format).toBeUndefined()
    })

    it('sets response_format when responseFormat: "json_object" is requested', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: '{}' } }] }),
        )
        await chat([{ role: 'user', content: 'hi' }], {
            responseFormat: 'json_object',
        })
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        const body = JSON.parse(init.body as string)
        expect(body.response_format).toEqual({ type: 'json_object' })
    })

    it('throws OpenRouterError with the status + truncated body text on a non-ok response', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response('rate limited', { status: 429 }),
        )
        const promise = chat([{ role: 'user', content: 'hi' }])
        await expect(promise).rejects.toBeInstanceOf(OpenRouterError)
        await expect(promise).rejects.toMatchObject({
            name: 'OpenRouterError',
            status: 429,
        })
    })

    it('throws OpenRouterError("empty response") when the response has no message content', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }))
        await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            'empty response',
        )
    })
})

// F-011 — coarse cross-hop trace correlation: OpenRouter's own response `id`
// (generation id, visible in their dashboard) plus our locally-generated
// request id, stashed on the active Sentry span. Sentry already auto-spans
// this fetch (nativeNodeFetchIntegration) — this does NOT hand-roll a span,
// only annotates whatever is active (see PLAN-F-011.md).
describe('chat() — Sentry span trace correlation (F-011)', () => {
    it('sets openrouter.generation_id (from the response body) and openrouter.request_id (matching the X-Request-Id header) on the active span', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                id: 'gen-abc123',
                choices: [{ message: { content: 'hi there' } }],
            }),
        )

        await chat([{ role: 'user', content: 'hi' }])

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        const sentRequestId = (init.headers as Record<string, string>)[
            'X-Request-Id'
        ]

        expect(getActiveSpanMock).toHaveBeenCalledTimes(1)
        expect(setAttributesMock).toHaveBeenCalledTimes(1)
        expect(setAttributesMock).toHaveBeenCalledWith({
            'openrouter.request_id': sentRequestId,
            'openrouter.generation_id': 'gen-abc123',
        })
    })

    it('omits openrouter.generation_id when the response body has no id, but still sets our request_id', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: 'no id' } }] }),
        )

        await chat([{ role: 'user', content: 'hi' }])

        expect(setAttributesMock).toHaveBeenCalledWith({
            'openrouter.request_id': expect.any(String),
        })
    })

    it('is a no-op when there is no active span (Sentry disabled outside prod — see sentry.common.config.ts)', async () => {
        getActiveSpanMock.mockImplementationOnce(() => undefined)
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )

        await expect(chat([{ role: 'user', content: 'hi' }])).resolves.toBe(
            'ok',
        )
        expect(setAttributesMock).not.toHaveBeenCalled()
    })
})
