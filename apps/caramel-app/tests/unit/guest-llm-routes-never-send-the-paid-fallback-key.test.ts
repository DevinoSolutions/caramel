import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Paid fallback through the Devino proxy, driven through the REAL chat() and
// POST /api/classify-cart with only `fetch` stubbed at the network boundary
// (MOCK, announced: no request leaves the test). env.ts parses process.env
// once at import, so each test stubs the env and re-imports the module graph.
// The pure host/wait cases live in
// paid-fallback-key-reaches-only-the-devino-proxy-with-a-capped-wait.test.ts.
//
// Both production LLM paths go through chat() and are guest-reachable: the
// cart classifier (aborted at 7 s) and the coupon-box pick (20 s). No caller
// sends the paid-fallback headers, so with the key set every model request
// must still leave without them.

// MOCK (announced): Sentry is a log sink under test, and the real
// @sentry/nextjs import is slow enough to time out a re-import on a loaded
// machine.
const sentry = vi.hoisted(() => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    getActiveSpan: vi.fn(() => undefined),
    init: vi.fn(),
    setUser: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => sentry)

// MOCK (announced): the route's per-IP limiter and abuse fan-out are pinned in
// their own tests; switched off so these tests only see the model call.
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))

const PROXY_URL = 'https://proxyai.devino.ca/v1'
const TEST_FALLBACK_KEY = 'sk-or-v1-' + 'test000000000000000000000000'
const SENTINEL_KEY = 'sk-or-v1-NEVERLOGTHIS000000000000000000'
const TEST_PROXY_KEY = 'orf-test-proxy-key'

// Tests that re-import the whole classify-cart route graph after vi.resetModules
// need more than vitest's 5 s default on a loaded machine; a timed-out import
// would otherwise finish late and land its fetch in the NEXT test's stub.
const ROUTE_IMPORT_TIMEOUT_MS = 30_000

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

/** Stubs env + fetch, then re-imports the module graph so env.ts re-parses. */
function stubFallbackEnvAndFetch(
    fallbackKey: string,
    respond: typeof fetch = async () =>
        new Response(
            JSON.stringify({
                id: 'gen-test',
                choices: [
                    {
                        message: {
                            content:
                                '{"primary":"apparel","secondary":[],"confidence":0.9}',
                        },
                    },
                ],
            }),
            { status: 200 },
        ),
): FetchMock {
    vi.resetModules()
    vi.stubEnv('OPENROUTER_API_KEY', TEST_PROXY_KEY)
    vi.stubEnv('OPENROUTER_API_URL', PROXY_URL)
    vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', fallbackKey)
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'deepseek/deepseek-v4.1-flash')
    vi.stubEnv('OPENROUTER_FALLBACK_AFTER_SECONDS', '8')
    const fetchMock: FetchMock = vi.fn<typeof fetch>(respond)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

/** The X-ORF-Fallback-* headers of one stubbed request, by any casing. */
function fallbackHeadersOf(fetchMock: FetchMock, call = 0): string[] {
    const init = fetchMock.mock.calls[call]?.[1]
    return Array.from(new Headers(init?.headers).keys()).filter(name =>
        name.startsWith('x-orf-fallback-'),
    )
}

/** A guest request exactly as the extension sends it: no session, forged-able origin. */
function guestClassifyRequest(): NextRequest {
    return new NextRequest('http://localhost/api/classify-cart', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
            'cf-connecting-ip': '203.0.113.50',
        },
        body: JSON.stringify({
            domain: `shop-${crypto.randomUUID()}.example`,
            title: 'Your cart',
        }),
    })
}

afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const fn of Object.values(sentry)) fn.mockClear()
})

describe('the guest LLM routes with a paid-fallback key set', () => {
    it('chat() through the proxy sends no fallback header, with the 7 s classifier options or the 20 s coupon-box options, and the bearer is still the proxy key', async () => {
        const fetchMock = stubFallbackEnvAndFetch(TEST_FALLBACK_KEY)
        const { chat } = await import('@/lib/openrouter')

        await chat([{ role: 'user', content: 'hi' }], {
            responseFormat: 'json_object',
            timeoutMs: 7000,
        })
        await chat([{ role: 'user', content: 'hi' }], {
            responseFormat: 'json_object',
            timeoutMs: 20_000,
            reasoningEffort: 'low',
            headers: { 'X-ORF-Strict': '1' },
        })

        expect(fetchMock).toHaveBeenCalledTimes(2)
        for (const call of [0, 1]) {
            expect(fetchMock.mock.calls[call]?.[0]).toBe(
                `${PROXY_URL}/chat/completions`,
            )
            expect(fallbackHeadersOf(fetchMock, call)).toEqual([])
            expect(
                new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get(
                    'authorization',
                ),
            ).toBe(`Bearer ${TEST_PROXY_KEY}`)
        }
    })

    it(
        'a guest POST /api/classify-cart through the proxy sends no fallback header',
        async () => {
            const fetchMock = stubFallbackEnvAndFetch(TEST_FALLBACK_KEY)
            const { POST } = await import('@/app/api/classify-cart/route')

            const res = await POST(guestClassifyRequest())
            expect(res.status).toBe(200)
            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
                `${PROXY_URL}/chat/completions`,
            )
            expect(fallbackHeadersOf(fetchMock)).toEqual([])
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )

    it(
        'one classify is one fetch: there is no retry loop or model chain, so a 500 is requested exactly once',
        async () => {
            const fetchMock = stubFallbackEnvAndFetch(
                TEST_FALLBACK_KEY,
                async () => new Response('upstream exploded', { status: 500 }),
            )
            const { POST } = await import('@/app/api/classify-cart/route')
            vi.spyOn(console, 'error').mockImplementation(() => {})

            const res = await POST(guestClassifyRequest())
            expect(res.status).toBe(502)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )

    it(
        'the fallback key never appears in console, logs, Sentry or the response when the classifier call fails',
        async () => {
            const consoleCalls: unknown[][] = []
            for (const level of [
                'log',
                'info',
                'warn',
                'error',
                'debug',
            ] as const) {
                vi.spyOn(console, level).mockImplementation((...args) => {
                    consoleCalls.push(args)
                })
            }
            const stringify = (value: unknown): string => {
                if (value instanceof Error) {
                    return `${value.name} ${value.message} ${value.stack ?? ''} ${stringify('cause' in value ? value.cause : undefined)}`
                }
                try {
                    return JSON.stringify(value) ?? String(value)
                } catch {
                    return String(value)
                }
            }

            stubFallbackEnvAndFetch(
                SENTINEL_KEY,
                async () => new Response('upstream exploded', { status: 500 }),
            )
            const { POST } = await import('@/app/api/classify-cart/route')
            const res = await POST(guestClassifyRequest())
            expect(res.status).toBe(502)
            const body = await res.text()

            const sinks = [
                ...consoleCalls.flat(),
                ...sentry.captureException.mock.calls.flat(),
                ...sentry.captureMessage.mock.calls.flat(),
                body,
            ]
            expect(sentry.captureException).toHaveBeenCalled()
            for (const entry of sinks) {
                expect(stringify(entry)).not.toContain(SENTINEL_KEY)
            }
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )
})
