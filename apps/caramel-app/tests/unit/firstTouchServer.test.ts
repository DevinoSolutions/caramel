import {
    FIRST_TOUCH_COOKIE_NAME,
    serializeFirstTouchCookieValue,
    type FirstTouchRecord,
} from '@/lib/analytics/firstTouchRecord'
import {
    readFirstTouchFromHeaders,
    readPosthogDistinctId,
} from '@/lib/analytics/firstTouchServer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server half of first-touch capture: the cm_ft cookie is parsed with the
// SAME schema the browser wrote it with, and an invalid cookie is treated as
// absent but REPORTED (Sentry warning), never silently ignored.

const sentry = vi.hoisted(() => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => sentry)

const record: FirstTouchRecord = {
    utm_source: 'reddit',
    utm_campaign: 'launch',
    msclkid: 'm1',
    referrer_domain: 'news.ycombinator.com',
    landing_path: '/stores/nike',
    captured_at: '2026-10-01T12:00:00.000Z',
}

function headersWithCookie(cookie: string | null): Headers {
    const headers = new Headers()
    if (cookie !== null) headers.set('cookie', cookie)
    return headers
}

beforeEach(() => {
    sentry.captureMessage.mockClear()
    sentry.captureException.mockClear()
})

describe('readFirstTouchFromHeaders', () => {
    it('round-trips what the browser serializer wrote', () => {
        const cookie = `theme=dark; ${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(record)}; other=1`
        expect(readFirstTouchFromHeaders(headersWithCookie(cookie))).toEqual(
            record,
        )
        expect(sentry.captureMessage).not.toHaveBeenCalled()
    })

    it('is null with no cookie header, no cm_ft, or no headers at all (and says nothing)', () => {
        expect(readFirstTouchFromHeaders(headersWithCookie(null))).toBeNull()
        expect(readFirstTouchFromHeaders(headersWithCookie('a=1'))).toBeNull()
        expect(readFirstTouchFromHeaders(null)).toBeNull()
        expect(readFirstTouchFromHeaders(undefined)).toBeNull()
        expect(sentry.captureMessage).not.toHaveBeenCalled()
    })

    it.each([
        ['malformed JSON', '%7Bnot-json'],
        [
            'a JSON value of the wrong shape',
            encodeURIComponent('"just a string"'),
        ],
        [
            'a record missing captured_at',
            encodeURIComponent(JSON.stringify({ utm_source: 'reddit' })),
        ],
        [
            'a value over the length cap',
            encodeURIComponent(
                JSON.stringify({ ...record, utm_source: 'x'.repeat(256) }),
            ),
        ],
    ])('treats %s as absent and reports it to Sentry', (_label, raw) => {
        const result = readFirstTouchFromHeaders(
            headersWithCookie(`${FIRST_TOUCH_COOKIE_NAME}=${raw}`),
        )

        expect(result).toBeNull()
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(sentry.captureMessage.mock.calls[0]![0]).toMatch(
            /first-touch cookie present but invalid/,
        )
        expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({
            level: 'warning',
            tags: { operation: 'first_touch_cookie_parse' },
        })
    })

    it('uses a valid duplicate when an earlier cm_ft is invalid (and still reports the bad one)', () => {
        const cookie = `${FIRST_TOUCH_COOKIE_NAME}=%7Bbad; ${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(record)}`
        expect(readFirstTouchFromHeaders(headersWithCookie(cookie))).toEqual(
            record,
        )
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
    })
})

describe('readPosthogDistinctId', () => {
    const token = 'phc_test_token'
    const phCookie = (value: unknown) =>
        `ph_${token}_posthog=${encodeURIComponent(JSON.stringify(value))}`

    it('reads distinct_id out of the posthog-js persistence cookie', () => {
        const cookie = `a=1; ${phCookie({ distinct_id: 'anon-123', $sesid: [1, 'x', 2] })}`
        expect(readPosthogDistinctId(headersWithCookie(cookie), token)).toBe(
            'anon-123',
        )
    })

    it('is null when the cookie belongs to another project token', () => {
        expect(
            readPosthogDistinctId(
                headersWithCookie(phCookie({ distinct_id: 'anon-123' })),
                'phc_other',
            ),
        ).toBeNull()
        expect(sentry.captureMessage).not.toHaveBeenCalled()
    })

    it('reports an unreadable persistence cookie and makes no alias', () => {
        expect(
            readPosthogDistinctId(
                headersWithCookie(`ph_${token}_posthog=%7Bnope`),
                token,
            ),
        ).toBeNull()
        expect(
            readPosthogDistinctId(
                headersWithCookie(phCookie({ no_distinct_id: true })),
                token,
            ),
        ).toBeNull()
        expect(sentry.captureMessage).toHaveBeenCalledTimes(2)
        expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({
            tags: { operation: 'posthog_distinct_id_cookie_parse' },
        })
    })
})
