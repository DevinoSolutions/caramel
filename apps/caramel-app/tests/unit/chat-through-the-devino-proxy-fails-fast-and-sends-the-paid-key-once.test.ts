import { beforeEach, describe, expect, it, vi } from 'vitest'

// chat() through the Devino proxy fails fast (T-17816, rule C4g): a dropped
// connection or a 429/502/503/504 is retried at most twice inside the call's
// own timeout, the paid-fallback key rides the first attempt only, and no
// attempt follows a redirect. OpenRouter direct is unchanged: one send.
// Only `fetch` is stubbed, at the network boundary.
const { envMock } = vi.hoisted(() => ({
    envMock: {
        OPENROUTER_API_KEY: 'test-openrouter-key' as string | undefined,
        OPENROUTER_API_URL: 'https://proxyai.devino.ca/v1',
        OPENROUTER_MODEL: 'openai/gpt-5-mini',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@sentry/nextjs', () => ({ getActiveSpan: () => undefined }))

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)

import { chat, OpenRouterError } from '@/lib/openrouter'

const PROXY_URL = 'https://proxyai.devino.ca/v1'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
const FALLBACK_KEY = 'sk-or-v1-' + 'test000000000000000000000000'
const MESSAGES = [{ role: 'user' as const, content: 'x' }]

function answer(content = '{"ok":true}'): Response {
    return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
}

function busy(status = 503): Response {
    return new Response('{"error":{"message":"upstream busy"}}', { status })
}

/** What undici throws when the upstream drops the socket mid-request. */
function droppedConnection(): TypeError {
    return new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
        }),
    })
}

const fallbackKeyOf = (call: Parameters<typeof fetch>) =>
    new Headers(call[1]?.headers).get('x-orf-fallback-key')

beforeEach(() => {
    fetchMock.mockReset()
    envMock.OPENROUTER_API_URL = PROXY_URL
})

describe('chat() through the Devino proxy', () => {
    it('survives a dropped connection, sending the paid key on the first attempt only', async () => {
        fetchMock
            .mockRejectedValueOnce(droppedConnection())
            .mockImplementation(async () => answer())

        const reply = await chat(MESSAGES, {
            headers: { 'X-ORF-Fallback-Key': FALLBACK_KEY },
            timeoutMs: 20_000,
        })

        expect(reply).toBe('{"ok":true}')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fallbackKeyOf(fetchMock.mock.calls[0]!)).toBe(FALLBACK_KEY)
        expect(fallbackKeyOf(fetchMock.mock.calls[1]!)).toBeNull()
        // The fixed headers survive the retry.
        expect(
            new Headers(fetchMock.mock.calls[1]![1]?.headers).get(
                'authorization',
            ),
        ).toBe('Bearer test-openrouter-key')
    })

    it('never follows a redirect, paid key or not', async () => {
        fetchMock.mockImplementation(async () => answer())

        await chat(MESSAGES, { timeoutMs: 7000 })
        await chat(MESSAGES, {
            headers: { 'X-ORF-Fallback-Key': FALLBACK_KEY },
            timeoutMs: 20_000,
        })

        for (const [, init] of fetchMock.mock.calls)
            expect(init?.redirect).toBe('error')
    })

    it('gives up after three sends when the proxy stays busy, with the status on the error', async () => {
        fetchMock.mockImplementation(async () => busy(503))

        const failure = await chat(MESSAGES, { timeoutMs: 20_000 }).catch(
            (error: unknown) => error,
        )

        expect(failure).toBeInstanceOf(OpenRouterError)
        expect((failure as OpenRouterError).status).toBe(503)
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('retries only while the call budget leaves room for another attempt', async () => {
        fetchMock.mockImplementation(async () => busy(429))

        // 7 s (the cart classifier): after the first 429 and a 0.5 s wait,
        // more than 5 s are left, so one retry; after it, not enough for a third.
        await expect(chat(MESSAGES, { timeoutMs: 7000 })).rejects.toThrow(
            'openrouter 429',
        )
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('reports a proxy that sends no reply headers in time as a timed-out OpenRouterError', async () => {
        fetchMock.mockImplementation(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')),
                    )
                }),
        )

        const startedAt = Date.now()
        const failure = await chat(MESSAGES, { timeoutMs: 300 }).catch(
            (error: unknown) => error,
        )

        // Fast-fail and the call's own abort share the same budget; whichever
        // fires first, the call ends at it, and is reported as a timeout.
        expect(Date.now() - startedAt).toBeLessThan(2000)
        const timedOut =
            (failure instanceof OpenRouterError && failure.timedOut) ||
            (failure instanceof Error && failure.name === 'AbortError')
        expect(timedOut).toBe(true)
    })
})

describe('chat() on OpenRouter direct', () => {
    it('is unchanged: one send, the plain fetch, no retry', async () => {
        envMock.OPENROUTER_API_URL = OPENROUTER_URL
        fetchMock.mockImplementation(async () => busy(503))

        await expect(chat(MESSAGES, { timeoutMs: 7000 })).rejects.toThrow(
            'openrouter 503',
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0]![1]?.redirect).toBeUndefined()
    })
})
