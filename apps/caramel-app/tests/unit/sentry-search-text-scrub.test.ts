import {
    FILTERED,
    redactSensitiveText,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
} from '@/lib/sentryPiiScrub'
import type { Breadcrumb, ErrorEvent, init } from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'

// T-7505: what a shopper types into a store search must not survive in Sentry,
// the only copy of request URLs we keep (the Traefik access log is off, see
// RUNBOOK.md). The search text travels in GET /api/coupons/stores?q=,
// GET /api/coupons?search=&key_words=, and the `query` body field of
// POST /api/sites/search-supported.

type TransactionEvent = Parameters<
    NonNullable<
        NonNullable<Parameters<typeof init>[0]>['beforeSendTransaction']
    >
>[0]

const TYPED = 'my-private-typed-text'
const TYPED_ENCODED = 'my-private%20typed%20text'

function expectNoSearchText(value: unknown): void {
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain(TYPED)
    expect(serialized).not.toContain(TYPED_ENCODED)
}

describe('store-search text is scrubbed from Sentry events', () => {
    it('a server transaction: http.url, url.full, url.query and span data', () => {
        const event: TransactionEvent = {
            type: 'transaction',
            transaction: 'GET /api/coupons/stores',
            request: {
                url: `https://grabcaramel.com/api/coupons/stores?q=${TYPED_ENCODED}&limit=20`,
                query_string: `q=${TYPED_ENCODED}&limit=20`,
            },
            contexts: {
                trace: {
                    trace_id: 'a'.repeat(32),
                    span_id: 'b'.repeat(16),
                    op: 'http.server',
                    data: {
                        'http.url': `https://grabcaramel.com/api/coupons?search=${TYPED_ENCODED}&key_words=${TYPED_ENCODED}&page=1`,
                        'url.full': `https://grabcaramel.com/api/coupons/stores?q=${TYPED_ENCODED}`,
                        'url.query': `?q=${TYPED_ENCODED}&limit=20`,
                        'http.response.status_code': 200,
                    },
                },
            },
            spans: [
                {
                    span_id: 'c'.repeat(16),
                    trace_id: 'a'.repeat(32),
                    start_timestamp: 1,
                    status: 'ok',
                    description: `GET /api/coupons?search=${TYPED_ENCODED}`,
                    data: { 'url.query': `search=${TYPED_ENCODED}&limit=10` },
                },
            ],
        }

        const out = scrubSentryEvent(event)

        expect(out).not.toBeNull()
        expectNoSearchText(out)
        expect(out?.request?.url).toBe(
            `https://grabcaramel.com/api/coupons/stores?q=${FILTERED}&limit=20`,
        )
        expect(out?.contexts?.trace?.data).toMatchObject({
            'url.query': `?q=${FILTERED}&limit=20`,
            'http.response.status_code': 200,
        })
    })

    it('a browser fetch breadcrumb', () => {
        const crumb: Breadcrumb = {
            category: 'fetch',
            data: {
                url: `/api/coupons/stores?q=${TYPED_ENCODED}&limit=20`,
                method: 'GET',
                status_code: 200,
            },
        }

        const out = scrubSentryBreadcrumb(crumb)

        expectNoSearchText(out)
        expect(out?.data).toMatchObject({
            url: `/api/coupons/stores?q=${FILTERED}&limit=20`,
            method: 'GET',
            status_code: 200,
        })
    })

    it('an error event: request.query_string as string, object and pair list', () => {
        const base = (): ErrorEvent => ({
            type: undefined,
            message: 'Error fetching coupons.',
            request: {
                method: 'GET',
                url: `https://grabcaramel.com/api/coupons?search=${TYPED_ENCODED}&type=percent`,
            },
        })

        const asString = base()
        asString.request!.query_string = `search=${TYPED_ENCODED}&key_words=${TYPED_ENCODED}&type=percent`
        const stringOut = scrubSentryEvent(asString)
        expectNoSearchText(stringOut)
        expect(stringOut?.request?.query_string).toBe(
            `search=${FILTERED}&key_words=${FILTERED}&type=percent`,
        )

        const asObject = base()
        asObject.request!.query_string = {
            q: TYPED,
            search: TYPED,
            key_words: TYPED,
            type: 'percent',
        }
        const objectOut = scrubSentryEvent(asObject)
        expectNoSearchText(objectOut)
        expect(objectOut?.request?.query_string).toEqual({
            q: FILTERED,
            search: FILTERED,
            key_words: FILTERED,
            type: 'percent',
        })

        const asPairs = base()
        asPairs.request!.query_string = [
            ['q', TYPED],
            ['limit', '20'],
        ]
        const pairsOut = scrubSentryEvent(asPairs)
        expectNoSearchText(pairsOut)
        expect(pairsOut?.request?.query_string).toEqual([
            ['q', FILTERED],
            ['limit', '20'],
        ])
    })

    it('the search-supported body field, when it shows up in a JSON-looking message', () => {
        const text = redactSensitiveText(
            `parse failed: {"query":"${TYPED}","other":"kept"}`,
        )
        expect(text).not.toContain(TYPED)
        expect(text).toContain('"other":"kept"')
    })

    it('leaves unrelated params and look-alike names alone', () => {
        const url =
            'https://grabcaramel.com/coupons?site=nike.com&page=2&sort=newest&request=1&equal=2'
        expect(redactSensitiveText(url)).toBe(url)
    })
})
