import { parseServerEnv } from '@/lib/env'
import { buildProxyFallbackHeaders } from '@/lib/proxy-fallback-headers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import evalConfig from '../../vitest.eval.config'

// Paid fallback through the Devino proxy: the app's ONLY job is to attach its
// own OpenRouter key (+ optional model / after) as X-ORF-Fallback-* headers,
// and only when the base URL is the proxy. Same seven cases in every fleet app.
//
// The wiring tests drive the REAL `chat()` in src/lib/openrouter.ts with only
// `fetch` stubbed at the network boundary (MOCK, announced: no request leaves
// the test). env.ts parses process.env once at import, so each wiring test
// stubs the env and re-imports the module graph.

// MOCK (announced): chat() only calls Sentry.getActiveSpan(), which is
// undefined outside prod anyway; the real @sentry/nextjs import is slow enough
// to time out the first re-import on a loaded machine.
vi.mock('@sentry/nextjs', () => ({ getActiveSpan: () => undefined }))

const PROXY_URL = 'https://proxyai.devino.ca/v1'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
const TEST_FALLBACK_KEY = 'sk-or-v1-test-fallback-key'
const TEST_PROXY_KEY = 'orf-test-proxy-key'

const FALLBACK_HEADER_NAMES = [
    'X-ORF-Fallback-Key',
    'X-ORF-Fallback-Model',
    'X-ORF-Fallback-After',
]

function fallbackHeadersOnly(
    headers: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) =>
            FALLBACK_HEADER_NAMES.includes(name),
        ),
    )
}

async function sendOneChatAndCaptureRequestHeaders(env: {
    OPENROUTER_API_URL: string
    OPENROUTER_FALLBACK_API_KEY?: string
    OPENROUTER_FALLBACK_MODEL?: string
    OPENROUTER_FALLBACK_AFTER_SECONDS?: string
}): Promise<{ url: string; headers: Record<string, string> }> {
    vi.resetModules()
    vi.stubEnv('OPENROUTER_API_KEY', TEST_PROXY_KEY)
    vi.stubEnv('OPENROUTER_API_URL', env.OPENROUTER_API_URL)
    // undefined deletes the var, so "unset" really is unset for env.ts.
    vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', env.OPENROUTER_FALLBACK_API_KEY)
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', env.OPENROUTER_FALLBACK_MODEL)
    vi.stubEnv(
        'OPENROUTER_FALLBACK_AFTER_SECONDS',
        env.OPENROUTER_FALLBACK_AFTER_SECONDS,
    )
    const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) =>
            new Response(
                JSON.stringify({
                    id: 'gen-test',
                    choices: [
                        { message: { content: '{"primary":"apparel"}' } },
                    ],
                }),
                { status: 200 },
            ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { chat } = await import('@/lib/openrouter')
    await chat([{ role: 'user', content: 'classify this cart' }])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    return { url, headers: init.headers as Record<string, string> }
}

afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

describe('chat() sends the paid-fallback headers to the Devino proxy', () => {
    it('(1) with key + model + after set and the proxy as base URL, the request carries all three fallback headers and the bearer is still the proxy key', async () => {
        const { url, headers } = await sendOneChatAndCaptureRequestHeaders({
            OPENROUTER_API_URL: PROXY_URL,
            OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
            OPENROUTER_FALLBACK_MODEL: 'anthropic/claude-haiku-4.5',
            OPENROUTER_FALLBACK_AFTER_SECONDS: '3',
        })
        expect(url).toBe(`${PROXY_URL}/chat/completions`)
        expect(fallbackHeadersOnly(headers)).toEqual({
            'X-ORF-Fallback-Key': TEST_FALLBACK_KEY,
            'X-ORF-Fallback-Model': 'anthropic/claude-haiku-4.5',
            'X-ORF-Fallback-After': '3',
        })
        expect(headers.Authorization).toBe(`Bearer ${TEST_PROXY_KEY}`)
    })

    it('(2) with only the key set, the request carries the key header and no model or after header', async () => {
        const { headers } = await sendOneChatAndCaptureRequestHeaders({
            OPENROUTER_API_URL: PROXY_URL,
            OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
        })
        expect(fallbackHeadersOnly(headers)).toEqual({
            'X-ORF-Fallback-Key': TEST_FALLBACK_KEY,
        })
    })

    it('(3) with the key unset or blank, the request carries no fallback header even when model and after are set', async () => {
        for (const key of [undefined, '', '   ']) {
            const { headers } = await sendOneChatAndCaptureRequestHeaders({
                OPENROUTER_API_URL: PROXY_URL,
                OPENROUTER_FALLBACK_API_KEY: key,
                OPENROUTER_FALLBACK_MODEL: 'anthropic/claude-haiku-4.5',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '3',
            })
            expect(fallbackHeadersOnly(headers)).toEqual({})
        }
    })

    it('(4) with OpenRouter itself as base URL and the key set, the key is never sent to openrouter.ai', async () => {
        const { url, headers } = await sendOneChatAndCaptureRequestHeaders({
            OPENROUTER_API_URL: OPENROUTER_URL,
            OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
            OPENROUTER_FALLBACK_MODEL: 'anthropic/claude-haiku-4.5',
            OPENROUTER_FALLBACK_AFTER_SECONDS: '3',
        })
        expect(url).toBe(`${OPENROUTER_URL}/chat/completions`)
        expect(fallbackHeadersOnly(headers)).toEqual({})
    })
})

describe('buildProxyFallbackHeaders', () => {
    it('(5) a *.openrouter.ai host counts as OpenRouter, while a gateway whose PATH contains openrouter.ai still gets the headers', () => {
        for (const baseUrl of [
            'https://eu.openrouter.ai/api/v1',
            'https://OPENROUTER.AI/api/v1',
        ]) {
            expect(
                buildProxyFallbackHeaders({
                    baseUrl,
                    key: TEST_FALLBACK_KEY,
                    model: undefined,
                }),
            ).toEqual({})
        }
        expect(
            buildProxyFallbackHeaders({
                baseUrl: 'https://gateway.example.com/openrouter.ai/v1',
                key: TEST_FALLBACK_KEY,
                model: undefined,
            }),
        ).toEqual({ 'X-ORF-Fallback-Key': TEST_FALLBACK_KEY })
        expect(
            buildProxyFallbackHeaders({
                baseUrl: 'https://notopenrouter.ai/v1',
                key: TEST_FALLBACK_KEY,
                model: undefined,
            }),
        ).toEqual({ 'X-ORF-Fallback-Key': TEST_FALLBACK_KEY })
    })

    it('(6) a blank, non-numeric, zero or negative after sends no After header, and 7.5 is sent as 7.5', () => {
        for (const afterSeconds of ['', '   ', 'abc', '0', '-5']) {
            expect(
                buildProxyFallbackHeaders({
                    baseUrl: PROXY_URL,
                    key: TEST_FALLBACK_KEY,
                    model: undefined,
                    afterSeconds,
                }),
            ).toEqual({ 'X-ORF-Fallback-Key': TEST_FALLBACK_KEY })
        }
        expect(
            buildProxyFallbackHeaders({
                baseUrl: PROXY_URL,
                key: TEST_FALLBACK_KEY,
                model: undefined,
                afterSeconds: ' 7.5 ',
            }),
        ).toEqual({
            'X-ORF-Fallback-Key': TEST_FALLBACK_KEY,
            'X-ORF-Fallback-After': '7.5',
        })
    })
})

describe('paid-fallback env vars', () => {
    const bootFixture = {
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:58005/caramel',
        BETTER_AUTH_SECRET: 'test-better-auth-secret',
    }

    it('(7) are optional: the server env boots with them unset, blank, or with a junk after value, and keeps a set key opaque', () => {
        const unset = parseServerEnv(bootFixture)
        expect(unset.OPENROUTER_FALLBACK_API_KEY).toBeUndefined()
        expect(unset.OPENROUTER_FALLBACK_MODEL).toBeUndefined()
        expect(unset.OPENROUTER_FALLBACK_AFTER_SECONDS).toBeUndefined()

        expect(() =>
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: '',
                OPENROUTER_FALLBACK_MODEL: '',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '',
            }),
        ).not.toThrow()
        expect(() =>
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_AFTER_SECONDS: 'abc',
            }),
        ).not.toThrow()
        expect(
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
            }).OPENROUTER_FALLBACK_API_KEY,
        ).toBe(TEST_FALLBACK_KEY)
    })

    it('are blanked in the eval config, so a key in a shell or local .env can never reach the eval gate', () => {
        const evalEnv = (
            evalConfig as unknown as { test?: { env?: Record<string, string> } }
        ).test?.env
        expect(evalEnv).toMatchObject({
            OPENROUTER_FALLBACK_API_KEY: '',
            OPENROUTER_FALLBACK_MODEL: '',
            OPENROUTER_FALLBACK_AFTER_SECONDS: '',
        })
    })
})
