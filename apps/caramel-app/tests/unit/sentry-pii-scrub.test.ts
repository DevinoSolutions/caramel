import {
    FILTERED,
    redactSensitiveText,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
} from '@/lib/sentryPiiScrub'
import type { Breadcrumb, ErrorEvent, init } from '@sentry/nextjs'
import * as Sentry from '@sentry/nextjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// T-5535 M5 / L6. With `sendDefaultPii: true` the SDK attached request headers
// (Authorization, Cookie), the OAuth callback query (`?code=…&state=…`) and the
// caller's IP to Sentry events, and call sites put e-mails and IPs into
// `extra`. These tests feed representative events through the scrubber and
// check two things: every secret below is gone from the serialized event, and
// the fields triage actually uses survive.

type TransactionEvent = Parameters<
    NonNullable<
        NonNullable<Parameters<typeof init>[0]>['beforeSendTransaction']
    >
>[0]

const SECRETS = [
    'SECRET-CODE',
    'SECRET-STATE',
    'SECRET-ID-TOKEN',
    'SECRET-ACCESS',
    'SECRET-BEARER',
    'SECRET-COOKIE',
    'SECRET-SESSION',
    'SECRET-USERINFO',
    'victim@example.com',
    '203.0.113.7',
]

/** scrubSentryEvent, asserting the event was kept (not dropped). */
function scrubbed<T extends Parameters<typeof scrubSentryEvent>[0]>(
    event: T,
): T {
    const out = scrubSentryEvent(event)
    if (out === null) throw new Error('event was dropped by the scrubber')
    return out
}

function expectNoSecrets(value: unknown): void {
    const serialized = JSON.stringify(value)
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
}

const CALLBACK =
    'https://grabcaramel.com/api/auth/callback/google?code=SECRET-CODE&state=SECRET-STATE&scope=email&utm_source=ad'

function errorEvent(): ErrorEvent {
    return {
        type: undefined,
        event_id: 'evt1',
        release: 'abc123',
        message: `Failed to fetch ${CALLBACK}`,
        tags: { route: '/api/auth/callback/[provider]', surface: 'auth' },
        user: {
            id: 'user_1',
            email: 'victim@example.com',
            username: 'victim',
            ip_address: '203.0.113.7',
        },
        request: {
            method: 'GET',
            url: CALLBACK,
            query_string: 'code=SECRET-CODE&state=SECRET-STATE&scope=email',
            cookies: { session: 'SECRET-SESSION' },
            data: { id_token: 'SECRET-ID-TOKEN' },
            headers: {
                Authorization: 'Bearer SECRET-BEARER',
                Cookie: 'better-auth.session_token=SECRET-COOKIE',
                'Set-Cookie': 'a=SECRET-COOKIE',
                'X-Forwarded-For': '203.0.113.7',
                Referer: `${CALLBACK}#access_token=SECRET-ACCESS`,
                'User-Agent': 'Mozilla/5.0',
                Accept: 'application/json',
            },
            env: { REMOTE_ADDR: '203.0.113.7' },
        },
        extra: {
            userEmail: 'victim@example.com',
            ip: '203.0.113.7',
            client_hash: 'h_9f2c',
            rejections_in_window: 7,
            maxKeys: 500,
            note: 'sent Authorization: Bearer SECRET-BEARER upstream',
            nested: { access_token: 'SECRET-ACCESS', keep: 'yes' },
        },
        exception: {
            values: [
                {
                    type: 'TypeError',
                    value: `fetch failed https://user:SECRET-USERINFO@idp.example/token?id_token=SECRET-ID-TOKEN&x=1`,
                    stacktrace: {
                        frames: [{ filename: 'app/route.ts', lineno: 12 }],
                    },
                },
            ],
        },
        breadcrumbs: [
            {
                type: 'http',
                category: 'fetch',
                data: { url: CALLBACK, method: 'GET', status_code: 302 },
            },
        ],
    }
}

describe('scrubSentryEvent: error events', () => {
    it('removes every secret from the serialized event', () => {
        expectNoSecrets(scrubbed(errorEvent()))
    })

    it('drops credential headers, keeps the useful ones', () => {
        const { request } = scrubbed(errorEvent())
        expect(request?.headers?.['Authorization']).toBe(FILTERED)
        expect(request?.headers?.['Cookie']).toBe(FILTERED)
        expect(request?.headers?.['Set-Cookie']).toBe(FILTERED)
        expect(request?.headers?.['X-Forwarded-For']).toBe(FILTERED)
        expect(request?.headers?.['User-Agent']).toBe('Mozilla/5.0')
        expect(request?.headers?.['Accept']).toBe('application/json')
        expect(request?.cookies).toBeUndefined()
        expect(request?.data).toBeUndefined()
        expect(request?.env?.['REMOTE_ADDR']).toBeUndefined()
    })

    it('redacts only the credential params of the URL and query string', () => {
        const { request } = scrubbed(errorEvent())
        expect(request?.url).toBe(
            `https://grabcaramel.com/api/auth/callback/google?code=${FILTERED}&state=${FILTERED}&scope=email&utm_source=ad`,
        )
        expect(request?.query_string).toBe(
            `code=${FILTERED}&state=${FILTERED}&scope=email`,
        )
        expect(request?.method).toBe('GET')
    })

    it('handles object and pair-list query strings', () => {
        const asObject = errorEvent()
        asObject.request!.query_string = {
            code: 'SECRET-CODE',
            state: 'SECRET-STATE',
            page: '2',
        }
        const objectOut = scrubbed(asObject).request?.query_string
        expect(objectOut).toEqual({
            code: FILTERED,
            state: FILTERED,
            page: '2',
        })

        const asPairs = errorEvent()
        asPairs.request!.query_string = [
            ['id_token', 'SECRET-ID-TOKEN'],
            ['page', '2'],
        ]
        expect(scrubbed(asPairs).request?.query_string).toEqual([
            ['id_token', FILTERED],
            ['page', '2'],
        ])
    })

    it('keeps the user id, tags, release and numeric extras for triage', () => {
        const out = scrubbed(errorEvent())
        expect(out.user).toEqual({ id: 'user_1' })
        expect(out.tags).toEqual({
            route: '/api/auth/callback/[provider]',
            surface: 'auth',
        })
        expect(out.release).toBe('abc123')
        expect(out.extra).toMatchObject({
            client_hash: 'h_9f2c',
            rejections_in_window: 7,
            maxKeys: 500,
            userEmail: FILTERED,
            ip: FILTERED,
            nested: { access_token: FILTERED, keep: 'yes' },
        })
        expect(out.exception?.values?.[0]).toMatchObject({
            type: 'TypeError',
            stacktrace: { frames: [{ filename: 'app/route.ts', lineno: 12 }] },
        })
    })

    it('redacts URLs inside messages, exception values and breadcrumbs', () => {
        const out = scrubbed(errorEvent())
        expect(out.message).toContain(`code=${FILTERED}`)
        expect(out.message).toContain('utm_source=ad')
        expect(out.exception?.values?.[0]?.value).toContain(
            `id_token=${FILTERED}&x=1`,
        )
        expect(out.breadcrumbs?.[0]?.data).toMatchObject({
            url: expect.stringContaining(`state=${FILTERED}`),
            status_code: 302,
        })
    })
})

describe('scrubSentryEvent: transactions', () => {
    const transaction = (): TransactionEvent => ({
        type: 'transaction',
        transaction: 'GET /api/auth/callback/[provider]',
        request: {
            url: CALLBACK,
            headers: { Authorization: 'Bearer SECRET-BEARER' },
        },
        contexts: {
            trace: {
                trace_id: 'a'.repeat(32),
                span_id: 'b'.repeat(16),
                op: 'http.server',
                data: {
                    'http.url': CALLBACK,
                    'url.full': CALLBACK,
                    'url.query': '?code=SECRET-CODE&state=SECRET-STATE',
                    'http.request.header.cookie': 'x',
                    'http.response.status_code': 302,
                },
            },
        },
        spans: [
            {
                span_id: 'c'.repeat(16),
                trace_id: 'a'.repeat(32),
                start_timestamp: 1,
                description: `POST https://idp.example/token?code=SECRET-CODE`,
                data: {
                    'http.url': 'https://idp.example/token?code=SECRET-CODE',
                    'url.query':
                        'code=SECRET-CODE&grant_type=authorization_code',
                    'http.query': 'access_token=SECRET-ACCESS',
                },
            },
        ],
    })

    it('removes secrets from the trace context and every span', () => {
        expectNoSecrets(scrubbed(transaction()))
    })

    it('keeps trace ids, op, status and the transaction name', () => {
        const out = scrubbed(transaction())
        expect(out.transaction).toBe('GET /api/auth/callback/[provider]')
        expect(out.contexts?.trace).toMatchObject({
            trace_id: 'a'.repeat(32),
            span_id: 'b'.repeat(16),
            op: 'http.server',
            data: { 'http.response.status_code': 302 },
        })
        expect(out.spans?.[0]?.data['url.query']).toBe(
            `code=${FILTERED}&grant_type=authorization_code`,
        )
    })
})

describe('scrubSentryBreadcrumb', () => {
    it('redacts fetch, xhr and navigation URLs', () => {
        const fetchCrumb: Breadcrumb = {
            category: 'fetch',
            data: { url: CALLBACK, method: 'GET', status_code: 200 },
        }
        const navigation: Breadcrumb = {
            category: 'navigation',
            data: {
                from: '/signin',
                to: '/auth/done?code=SECRET-CODE&state=SECRET-STATE#id_token=SECRET-ID-TOKEN',
            },
        }
        const out = [fetchCrumb, navigation].map(scrubSentryBreadcrumb)
        expectNoSecrets(out)
        expect(out[0]?.data).toMatchObject({ method: 'GET', status_code: 200 })
        expect(out[1]?.data).toMatchObject({
            from: '/signin',
            to: `/auth/done?code=${FILTERED}&state=${FILTERED}#id_token=${FILTERED}`,
        })
    })
})

describe('redactSensitiveText', () => {
    it('leaves text without credentials unchanged', () => {
        const text =
            'https://grabcaramel.com/coupons/stores/amazon?page=2&sort=best#top'
        expect(redactSensitiveText(text)).toBe(text)
    })

    it('redacts relative URLs, fragments and percent-encoded names', () => {
        expect(redactSensitiveText('/cb?Code=1&%73tate=2&ok=3')).toBe(
            `/cb?Code=${FILTERED}&%73tate=${FILTERED}&ok=3`,
        )
        expect(
            redactSensitiveText('/cb#access_token=1&token_type=bearer'),
        ).toBe(`/cb#access_token=${FILTERED}&token_type=${FILTERED}`)
    })

    it('redacts bearer tokens and e-mail addresses in free text', () => {
        expect(
            redactSensitiveText('Authorization: Bearer abcdefgh12345 sent'),
        ).toBe(`Authorization: Bearer ${FILTERED} sent`)
        expect(redactSensitiveText('mail to a.b+c@example.co.uk failed')).toBe(
            'mail to [Filtered email] failed',
        )
    })
})

describe('Sentry init wiring', () => {
    const app = join(__dirname, '..', '..')
    const read = (file: string): string => readFileSync(join(app, file), 'utf8')

    it('keeps sendDefaultPii off in every init', () => {
        for (const file of [
            'sentry.common.config.ts',
            'src/instrumentation-client.ts',
        ]) {
            const source = read(file)
            expect(source).not.toMatch(/sendDefaultPii:\s*true/)
            expect(source).toMatch(/sendDefaultPii:\s*false/)
        }
    })

    it('runs the scrub on events, transactions and breadcrumbs in every init', () => {
        for (const file of [
            'sentry.common.config.ts',
            'src/instrumentation-client.ts',
        ]) {
            const source = read(file)
            expect(source).toMatch(/beforeSend:[\s\S]*?scrubSentryEvent/)
            expect(source).toMatch(/beforeSendTransaction:\s*scrubSentryEvent/)
            expect(source).toMatch(/beforeBreadcrumb:\s*scrubSentryBreadcrumb/)
        }
    })
})

describe('redactSensitiveText: IPs, JWTs, JSON, nested URLs, e-mails', () => {
    it('redacts IPv4 and IPv6 addresses but not versions or UA strings', () => {
        expect(redactSensitiveText('connect ECONNREFUSED 10.0.0.5:5432')).toBe(
            'connect ECONNREFUSED [Filtered ip]:5432',
        )
        expect(
            redactSensitiveText('from fe80::1 and 2001:db8::ff00:42:8329'),
        ).toBe('from [Filtered ip] and [Filtered ip]')
        expect(redactSensitiveText('peer ::1 refused')).toBe(
            'peer [Filtered ip] refused',
        )
        for (const keep of [
            'Chrome/120.0.0.0',
            'release v1.2.3.4',
            'sdk 10.65.0',
            'build 1.2.3.4.5',
            'at 12:30:45 on Foo::bar',
        ]) {
            expect(redactSensitiveText(keep)).toBe(keep)
        }
    })

    it('redacts bare JWTs, JSON-in-string pairs and nested encoded URLs', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'
        expect(redactSensitiveText(`bad token ${jwt} here`)).toBe(
            'bad token [Filtered jwt] here',
        )
        expect(
            redactSensitiveText(
                'body {"code":"SECRET-CODE","id_token":"SECRET-ID-TOKEN","page":"2"}',
            ),
        ).toBe(
            `body {"code":"${FILTERED}","id_token":"${FILTERED}","page":"2"}`,
        )
        expect(
            redactSensitiveText('/x?next=%2Fcb%3Fcode%3DSECRET-CODE&a=1'),
        ).toBe(`/x?next=${FILTERED}&a=1`)
        expect(redactSensitiveText('/x?next=%2Fstores%2Famazon&a=1')).toBe(
            '/x?next=%2Fstores%2Famazon&a=1',
        )
    })

    it('does not mangle package@version strings, still redacts e-mails', () => {
        for (const keep of [
            'caramel@1.4.17-beta.rc',
            'pnpm/foo@1.2.3-rc.beta/x.js',
            '@sentry/nextjs@10.65.0',
        ]) {
            expect(redactSensitiveText(keep)).toBe(keep)
        }
        expect(redactSensitiveText('mail victim@example.com now')).toBe(
            'mail [Filtered email] now',
        )
    })
})

describe('scrubSentryEvent: more keys', () => {
    it('filters client-IP headers and dotted span attribute keys', () => {
        const event = errorEvent()
        event.request!.headers = {
            'X-Client-IP': '203.0.113.7',
            'True-Client-IP': '203.0.113.7',
            'User-Agent': 'ua',
        }
        event.extra = {
            'http.request.header.cookie': ['sid=SECRET-COOKIE'],
            'http.request.header.authorization': 'Bearer SECRET-BEARER',
            'http.response.header.set-cookie': 'a=SECRET-COOKIE',
            'client.address': '203.0.113.7',
            'http.response.status_code': 200,
        }
        const out = scrubbed(event)
        expect(out?.request?.headers).toEqual({
            'X-Client-IP': FILTERED,
            'True-Client-IP': FILTERED,
            'User-Agent': 'ua',
        })
        expect(out?.extra).toEqual({
            'http.request.header.cookie': FILTERED,
            'http.request.header.authorization': FILTERED,
            'http.response.header.set-cookie': FILTERED,
            'client.address': FILTERED,
            'http.response.status_code': 200,
        })
    })
})

describe('scrubSentryEvent: SDK-owned objects and failures', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('leaves the live Scope and Client under sdkProcessingMetadata alone', async () => {
        const dsn = 'https://pubkey@o1.ingest.example.com/1'
        Sentry.init({
            dsn,
            tracesSampleRate: 1,
            integrations: [],
            transport: () => ({
                send: async () => ({}),
                flush: async () => true,
            }),
        })
        const client = Sentry.getClient()
        expect(client).toBeDefined()
        const scope = new Sentry.Scope()
        scope.setClient(client!)
        const event = {
            type: 'transaction' as const,
            transaction: 'GET /cb',
            request: { url: CALLBACK },
            sdkProcessingMetadata: {
                capturedSpanScope: scope,
                capturedSpanIsolationScope: scope,
            },
        }
        const out = scrubbed(event)
        expect(out).toBe(event)
        expect(out?.request?.url).toContain(`code=${FILTERED}`)
        expect(out?.sdkProcessingMetadata.capturedSpanScope).toBe(scope)
        expect(client!.getOptions().dsn).toBe(dsn)
        expect(client!.getDsn()?.publicKey).toBe('pubkey')
        await Sentry.close()
    })

    it('only rewrites plain objects and arrays', () => {
        class Holder {
            get locked(): string {
                return 'https://x/?code=SECRET-CODE'
            }
        }
        const holder = new Holder()
        const event = errorEvent()
        event.extra = { holder, list: [{ url: CALLBACK }] }
        const out = scrubbed(event)
        expect(out?.extra?.['holder']).toBe(holder)
        expect(JSON.stringify(out?.extra?.['list'])).not.toContain(
            'SECRET-CODE',
        )
    })

    it('drops the event, loudly and without its payload, if scrubbing throws', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const event = errorEvent()
        Object.defineProperty(event, 'request', {
            get() {
                throw new Error('boom')
            },
        })
        expect(scrubSentryEvent(event)).toBeNull()
        expect(error).toHaveBeenCalledTimes(1)
        const logged = String(error.mock.calls[0]?.[0])
        expect(logged).toContain('beforeSend')
        expect(logged).toContain('boom')
        expect(logged).not.toContain('SECRET')
    })

    it('drops the breadcrumb if scrubbing throws', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const crumb: Breadcrumb = { category: 'fetch' }
        Object.defineProperty(crumb, 'data', {
            enumerable: true,
            get() {
                throw new Error('boom')
            },
        })
        expect(scrubSentryBreadcrumb(crumb)).toBeNull()
    })
})
