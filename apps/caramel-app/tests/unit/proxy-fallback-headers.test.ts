import { parseServerEnv } from '@/lib/env'
import { buildProxyFallbackHeaders } from '@/lib/proxy-fallback-headers'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Paid fallback through the Devino proxy (fleet hardening v2, the same 16
// cases in every Devino app). Cases 1-9 drive the canonical pure helper;
// 10-16 drive the REAL chat() / POST /api/classify-cart with only `fetch`
// stubbed at the network boundary (MOCK, announced: no request leaves the
// test). env.ts parses process.env once at import, so each wiring test stubs
// the env and re-imports the module graph.
//
// Caramel has ONE LLM path today, the cart classifier: guest-reachable (the
// extension calls it without a session) and aborted at 7 s, so it never
// carries the headers (C3 + C5). chat({ paidFallback: true }) is the opt-in a
// future signed-in path with a >= 15 s deadline would use; cases 10/11/15
// drive that opt-in.

// MOCK (announced): Sentry is a log sink under test in case 15, and the real
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
const FALLBACK_HEADER_NAMES = [
    'X-ORF-Fallback-Key',
    'X-ORF-Fallback-Model',
    'X-ORF-Fallback-After',
]

function headersFor(input: {
    baseUrl?: string
    key?: string
    model?: string
    afterSeconds?: string
}): Record<string, string> {
    return buildProxyFallbackHeaders({
        baseUrl: 'baseUrl' in input ? input.baseUrl : PROXY_URL,
        key: input.key,
        model: input.model,
        afterSeconds: input.afterSeconds,
    })
}

function fallbackHeadersOnly(
    headers: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) =>
            FALLBACK_HEADER_NAMES.includes(name),
        ),
    )
}

// Tests that re-import the whole classify-cart route graph after vi.resetModules
// need more than vitest's 5 s default on a loaded machine; a timed-out import
// would otherwise finish late and land its fetch in the NEXT test's stub.
const ROUTE_IMPORT_TIMEOUT_MS = 30_000

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

/** Stubs env + fetch, then re-imports the module graph so env.ts re-parses. */
function stubFallbackEnvAndFetch(
    fallbackKey: string | undefined,
    respond: () => Promise<Response> = async () =>
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
    // undefined deletes the var, so "unset" really is unset for env.ts.
    vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', fallbackKey)
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', undefined)
    vi.stubEnv('OPENROUTER_FALLBACK_AFTER_SECONDS', undefined)
    const fetchMock: FetchMock = vi.fn<typeof fetch>(respond)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

function requestHeaders(fetchMock: FetchMock, call = 0) {
    const init = fetchMock.mock.calls[call]?.[1]
    return (init?.headers ?? {}) as Record<string, string>
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

describe('Caramel wiring of the paid-fallback headers', () => {
    it('(10) a signed-in chat() call that opts in through the proxy carries the key and After "8", and the bearer is still the proxy key; without the opt-in it carries nothing', async () => {
        const fetchMock = stubFallbackEnvAndFetch(TEST_FALLBACK_KEY)
        const { chat } = await import('@/lib/openrouter')

        await chat([{ role: 'user', content: 'hi' }], {
            paidFallback: true,
            timeoutMs: 30_000,
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            `${PROXY_URL}/chat/completions`,
        )
        expect(fallbackHeadersOnly(requestHeaders(fetchMock))).toEqual({
            'X-ORF-Fallback-Key': TEST_FALLBACK_KEY,
            'X-ORF-Fallback-After': '8',
        })
        expect(requestHeaders(fetchMock).Authorization).toBe(
            `Bearer ${TEST_PROXY_KEY}`,
        )

        await chat([{ role: 'user', content: 'hi' }])
        expect(fallbackHeadersOnly(requestHeaders(fetchMock, 1))).toEqual({})
    })

    it('never invokes the paid reader for a client deadline below 15 seconds', async () => {
        const fetchMock = stubFallbackEnvAndFetch(TEST_FALLBACK_KEY)
        const reader = await import('@/lib/proxy-fallback-env')
        const readerSpy = vi.spyOn(reader, 'proxyFallbackHeaders')
        const { chat } = await import('@/lib/openrouter')
        await chat([{ role: 'user', content: 'hi' }], {
            paidFallback: true,
            timeoutMs: 7000,
        })
        expect(fallbackHeadersOnly(requestHeaders(fetchMock))).toEqual({})
        expect(readerSpy).not.toHaveBeenCalled()
    })

    it('(11) chat() never retries: a failing opted-in call makes exactly one request with the key set, and exactly one without it', async () => {
        for (const key of [TEST_FALLBACK_KEY, undefined]) {
            const fetchMock = stubFallbackEnvAndFetch(
                key,
                async () => new Response('upstream down', { status: 503 }),
            )
            const { chat, OpenRouterError } = await import('@/lib/openrouter')
            await expect(
                chat([{ role: 'user', content: 'hi' }], {
                    paidFallback: true,
                    timeoutMs: 30_000,
                }),
            ).rejects.toBeInstanceOf(OpenRouterError)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        }
    })

    it(
        '(12) a guest POST /api/classify-cart through the proxy, with the key set, sends no fallback header (guest path and 7 s deadline both keep it free)',
        async () => {
            const fetchMock = stubFallbackEnvAndFetch(TEST_FALLBACK_KEY)
            const reader = await import('@/lib/proxy-fallback-env')
            const readerSpy = vi.spyOn(reader, 'proxyFallbackHeaders')
            const { POST } = await import('@/app/api/classify-cart/route')

            const res = await POST(guestClassifyRequest())
            expect(res.status).toBe(200)
            expect(readerSpy).not.toHaveBeenCalled()
            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
                `${PROXY_URL}/chat/completions`,
            )
            expect(fallbackHeadersOnly(requestHeaders(fetchMock))).toEqual({})
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )

    it(
        '(13) the single-paid-attempt rule has no retry loop or model chain to pin in Caramel: one classify is one fetch',
        async () => {
            const fetchMock = stubFallbackEnvAndFetch(
                TEST_FALLBACK_KEY,
                async () => new Response('upstream down', { status: 503 }),
            )
            const { POST } = await import('@/app/api/classify-cart/route')
            vi.spyOn(console, 'error').mockImplementation(() => {})

            const res = await POST(guestClassifyRequest())
            expect(res.status).toBe(502)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )

    it('(14) the real eval config and the Playwright config blank all three vars, so a key in a shell or .env never reaches evals or e2e', async () => {
        vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', TEST_FALLBACK_KEY)
        vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'vendor/test')
        vi.stubEnv('OPENROUTER_FALLBACK_AFTER_SECONDS', '50')
        vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {})
        const evalConfig = (await import('../../vitest.eval.config')).default
        const evalEnv = (
            evalConfig as unknown as {
                test?: { env?: Record<string, string> }
            }
        ).test?.env
        expect(evalEnv).toMatchObject({
            OPENROUTER_FALLBACK_API_KEY: '',
            OPENROUTER_FALLBACK_MODEL: '',
            OPENROUTER_FALLBACK_AFTER_SECONDS: '',
        })
        // vitest applies test.env OVER the inherited process env: a shell key
        // is overwritten by the blank, which the helper treats as unset.
        const evalProcessEnv = {
            OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
            ...evalEnv,
        }
        expect(
            headersFor({ key: evalProcessEnv.OPENROUTER_FALLBACK_API_KEY }),
        ).toEqual({})

        // Source pin: playwright.config.ts cannot be loaded in a unit test
        // (it starts a web server), so pin the blanking in its webServer env.
        const testDir = path.dirname(fileURLToPath(import.meta.url))
        const playwrightSource = fs.readFileSync(
            path.resolve(testDir, '../../playwright.config.ts'),
            'utf8',
        )
        for (const name of [
            'OPENROUTER_FALLBACK_API_KEY',
            'OPENROUTER_FALLBACK_MODEL',
            'OPENROUTER_FALLBACK_AFTER_SECONDS',
        ]) {
            expect(playwrightSource).toMatch(new RegExp(`\\b${name}: '',`))
        }
    })

    it(
        '(15) the fallback key never appears in console, logs or Sentry when an LLM call fails',
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

            // (a) the opted-in chat() path: 500 and abort.
            for (const respond of [
                async () => new Response('upstream exploded', { status: 500 }),
                async () => {
                    throw new DOMException('aborted', 'AbortError')
                },
            ]) {
                stubFallbackEnvAndFetch(SENTINEL_KEY, respond)
                const { chat } = await import('@/lib/openrouter')
                const { handleRouteError } = await import(
                    '@/lib/api/handleRouteError'
                )
                const error = await chat([{ role: 'user', content: 'hi' }], {
                    paidFallback: true,
                    timeoutMs: 30_000,
                }).catch((e: unknown) => e)
                expect(error).toBeInstanceOf(Error)
                console.error('[test] failed', error)
                handleRouteError(error, { route: '/api/test' })
            }

            // (b) the real guest route failing end to end.
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
            expect(sinks.length).toBeGreaterThan(0)
            expect(sentry.captureException).toHaveBeenCalled()
            for (const entry of sinks) {
                expect(stringify(entry)).not.toContain(SENTINEL_KEY)
            }
        },
        ROUTE_IMPORT_TIMEOUT_MS,
    )
})

describe('paid-fallback env vars at boot', () => {
    const bootFixture = {
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:58005/caramel',
        BETTER_AUTH_SECRET: 'test-better-auth-secret',
    }

    it('(16) the env schema accepts them unset or blank, and refuses a malformed key, model or after naming the variable but never the value', () => {
        expect(() => parseServerEnv(bootFixture)).not.toThrow()
        expect(() =>
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: '',
                OPENROUTER_FALLBACK_MODEL: '',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '',
            }),
        ).not.toThrow()
        expect(
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
                OPENROUTER_FALLBACK_MODEL: 'deepseek/deepseek-v4.1-flash',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '8',
            }).OPENROUTER_FALLBACK_API_KEY,
        ).toBe(TEST_FALLBACK_KEY)

        const badKey = 'sk-or-v1-SECRETVALUE\nwith-a-newline-000000'
        for (const [name, value] of [
            ['OPENROUTER_FALLBACK_API_KEY', badKey],
            ['OPENROUTER_FALLBACK_MODEL', 'bad model'],
            ['OPENROUTER_FALLBACK_AFTER_SECONDS', '1e3'],
        ] as const) {
            let message = ''
            try {
                parseServerEnv({ ...bootFixture, [name]: value })
            } catch (e) {
                message = (e as Error).message
            }
            expect(message).toContain(name)
            expect(message).not.toContain(value)
        }
    })
})
