import {
    FILTERED,
    redactSensitiveText,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
} from '@/lib/sentryPiiScrub'
import type { Breadcrumb, ErrorEvent, init } from '@sentry/nextjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
        expectNoSecrets(scrubSentryEvent(errorEvent()))
    })

    it('drops credential headers, keeps the useful ones', () => {
        const { request } = scrubSentryEvent(errorEvent())
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
        const { request } = scrubSentryEvent(errorEvent())
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
        const objectOut = scrubSentryEvent(asObject).request?.query_string
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
        expect(scrubSentryEvent(asPairs).request?.query_string).toEqual([
            ['id_token', FILTERED],
            ['page', '2'],
        ])
    })

    it('keeps the user id, tags, release and numeric extras for triage', () => {
        const out = scrubSentryEvent(errorEvent())
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
        const out = scrubSentryEvent(errorEvent())
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
        expectNoSecrets(scrubSentryEvent(transaction()))
    })

    it('keeps trace ids, op, status and the transaction name', () => {
        const out = scrubSentryEvent(transaction())
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
