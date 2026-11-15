import { describe, expect, it, vi } from 'vitest'

import {
    AI_UNAVAILABLE_MESSAGE,
    AiUnavailableError,
    fastFailFetch,
    isAiUnavailableError,
} from '@/lib/ai-fast-fail'

type Call = { headers: Headers; signal?: AbortSignal | null | undefined }

/** A fetch that answers from a script, one entry per call. */
function scripted(steps: Array<Response | Error | 'hang'>) {
    const calls: Call[] = []
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push({
            headers: new Headers(init?.headers),
            signal: init?.signal,
        })
        const step = steps[calls.length - 1]
        if (step === undefined) throw new Error('unexpected extra call')
        if (step === 'hang') {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('aborted', 'AbortError')),
                )
            })
        }
        if (step instanceof Error) throw step
        return step
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const noSleep: (
    ms: number,
    signal?: AbortSignal | null,
) => Promise<void> = async () => {}
const body = JSON.stringify({ model: 'haiku', messages: [] })
const paidInit: RequestInit = {
    method: 'POST',
    body,
    headers: {
        'X-ORF-Fallback-Key': 'sk-or-v1-x',
        'Content-Type': 'application/json',
    },
}

describe('fastFailFetch', () => {
    it('returns the first good reply without retrying', async () => {
        const { fetch, calls } = scripted([new Response('ok', { status: 200 })])
        const res = await fastFailFetch(fetch, { sleep: noSleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('ok')
        expect(calls).toHaveLength(1)
    })

    it('retries a 503 and a network error, then serves the third attempt', async () => {
        const { fetch, calls } = scripted([
            new Response('busy', { status: 503 }),
            new TypeError('fetch failed'),
            new Response('ok', { status: 200 }),
        ])
        const sleep = vi.fn(noSleep)
        const res = await fastFailFetch(fetch, { sleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(200)
        expect(calls).toHaveLength(3)
        expect(sleep.mock.calls.map(c => c[0])).toEqual([500, 1500])
    })

    it('sends the paid-fallback headers on the first attempt only', async () => {
        const { fetch, calls } = scripted([
            new Response('busy', { status: 502 }),
            new Response('ok', { status: 200 }),
        ])
        await fastFailFetch(fetch, { sleep: noSleep })('https://p/x', paidInit)
        expect(calls[0]!.headers.get('x-orf-fallback-key')).toBe('sk-or-v1-x')
        expect(calls[1]!.headers.get('x-orf-fallback-key')).toBeNull()
        expect(calls[1]!.headers.get('content-type')).toBe('application/json')
    })

    it('hands back the last reply when every attempt was a retryable status', async () => {
        const { fetch, calls } = scripted([
            new Response('a', { status: 503 }),
            new Response('b', { status: 503 }),
            new Response('c', { status: 504 }),
        ])
        const res = await fastFailFetch(fetch, { sleep: noSleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(504)
        expect(await res.text()).toBe('c')
        expect(calls).toHaveLength(3)
    })

    it('never retries a reply that is not a busy status', async () => {
        for (const status of [400, 401, 402, 404, 413, 422, 500]) {
            const { fetch, calls } = scripted([new Response('no', { status })])
            const res = await fastFailFetch(fetch, { sleep: noSleep })(
                'https://p/x',
                paidInit,
            )
            expect(res.status).toBe(status)
            expect(calls).toHaveLength(1)
        }
    })

    it('does not wait out a long Retry-After', async () => {
        const { fetch, calls } = scripted([
            new Response('cap', {
                status: 429,
                headers: { 'retry-after': '3600' },
            }),
        ])
        const res = await fastFailFetch(fetch, { sleep: noSleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(429)
        expect(calls).toHaveLength(1)
    })

    it('honours a short Retry-After', async () => {
        const { fetch } = scripted([
            new Response('slow down', {
                status: 429,
                headers: { 'retry-after': '2' },
            }),
            new Response('ok', { status: 200 }),
        ])
        const sleep = vi.fn(noSleep)
        const res = await fastFailFetch(fetch, { sleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(200)
        expect(sleep).toHaveBeenCalledWith(2000, undefined)
    })

    it('never retries past the limit, however short the Retry-After', async () => {
        const busy = () =>
            new Response('busy', {
                status: 429,
                headers: { 'retry-after': '0' },
            })
        const { fetch, calls } = scripted([busy(), busy(), busy(), busy()])
        const res = await fastFailFetch(fetch, { sleep: noSleep })(
            'https://p/x',
            paidInit,
        )
        expect(res.status).toBe(429)
        expect(calls).toHaveLength(3)
    })

    it('ends a silent upstream with a clear error inside the deadline', async () => {
        vi.useFakeTimers()
        try {
            const { fetch, calls } = scripted(['hang', 'hang', 'hang'])
            let clock = 0
            const call = fastFailFetch(fetch, {
                firstByteMs: 1_000,
                deadlineMs: 1_500,
                now: () => clock,
                sleep: noSleep,
            })('https://p/x', paidInit)
            const caught = call.catch((e: unknown) => e)
            clock = 1_000
            await vi.advanceTimersByTimeAsync(1_000)
            const error = await caught
            expect(isAiUnavailableError(error)).toBe(true)
            expect((error as AiUnavailableError).kind).toBe('timeout')
            expect((error as AiUnavailableError).message).toBe(
                AI_UNAVAILABLE_MESSAGE,
            )
            // 500 ms left is below the shortest attempt worth starting.
            expect(calls).toHaveLength(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not resend a body it cannot replay', async () => {
        const { fetch, calls } = scripted([new TypeError('fetch failed')])
        const stream = new ReadableStream({ start: c => c.close() })
        const call = fastFailFetch(fetch, { sleep: noSleep })('https://p/x', {
            method: 'POST',
            body: stream,
            // @ts-expect-error — Node needs `duplex` for a stream body; (2026-11-15)
            duplex: 'half',
        })
        await expect(call).rejects.toMatchObject({
            kind: 'network',
            attempts: 1,
        })
        expect(calls).toHaveLength(1)
    })

    it('stops at once when the caller aborts', async () => {
        const { fetch, calls } = scripted(['hang'])
        const controller = new AbortController()
        const call = fastFailFetch(fetch, { sleep: noSleep })('https://p/x', {
            ...paidInit,
            signal: controller.signal,
        })
        controller.abort(new Error('user left'))
        await expect(call).rejects.toThrow()
        await expect(call).rejects.not.toBeInstanceOf(AiUnavailableError)
        expect(calls).toHaveLength(1)
    })

    it('cuts a streamed body that goes silent', async () => {
        vi.useFakeTimers()
        try {
            const silent = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new TextEncoder().encode('data: {}\n\n'))
                },
            })
            const { fetch } = scripted([new Response(silent, { status: 200 })])
            const res = await fastFailFetch(fetch, { idleMs: 1_000 })(
                'https://p/x',
                paidInit,
            )
            const reader = res.body!.getReader()
            expect((await reader.read()).done).toBe(false)
            const next = reader.read().catch((e: unknown) => e)
            await vi.advanceTimersByTimeAsync(1_000)
            const error = await next
            expect(isAiUnavailableError(error)).toBe(true)
            expect((error as AiUnavailableError).kind).toBe('idle')
        } finally {
            vi.useRealTimers()
        }
    })
})
