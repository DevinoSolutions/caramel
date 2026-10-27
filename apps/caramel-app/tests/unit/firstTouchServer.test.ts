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
    const cookieName = `ph_${token}_posthog`
    // SYNTHETIC cookie builder (not captured from a real visitor): posthog-js
    // 1.438.x writes `encodeURIComponent(JSON.stringify(props))` for the keys
    // in its COOKIE_PERSISTED_PROPERTIES (storage.js cookieStore._set).
    const phCookie = (value: unknown) =>
        `${cookieName}=${encodeURIComponent(JSON.stringify(value))}`
    // SYNTHETIC full-fidelity anonymous snapshot in the real key layout.
    const syntheticAnonymousSnapshot = {
        $device_id: '00000000-0000-7000-8000-000000000001',
        distinct_id: '00000000-0000-7000-8000-000000000001',
        $sesid: [
            1798000000000,
            '00000000-0000-7000-8000-000000000002',
            1798000000000,
        ],
        $epp: true,
        $initial_person_info: {
            r: '$direct',
            u: 'https://example.test/welcome?utm_source=a%20b&x=1',
        },
        $user_state: 'anonymous',
    }

    function lastReport(): { extra: Record<string, unknown> } {
        const calls = sentry.captureMessage.mock.calls
        const call = calls[calls.length - 1]
        if (!call) throw new Error('expected a Sentry captureMessage call')
        return call[1] as { extra: Record<string, unknown> }
    }

    describe('accepted shapes', () => {
        it('reads an anonymous snapshot in the real posthog-js key layout', () => {
            expect(
                readPosthogDistinctId(
                    headersWithCookie(
                        `a=1; ${phCookie(syntheticAnonymousSnapshot)}`,
                    ),
                    token,
                ),
            ).toBe('00000000-0000-7000-8000-000000000001')
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })

        it('reads an identified snapshot (distinct_id is the user id)', () => {
            const cookie = phCookie({
                ...syntheticAnonymousSnapshot,
                distinct_id: 'user-uuid-1',
                $user_state: 'identified',
            })
            expect(
                readPosthogDistinctId(headersWithCookie(cookie), token),
            ).toBe('user-uuid-1')
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })

        it('reads the minimal legacy shape with only distinct_id', () => {
            expect(
                readPosthogDistinctId(
                    headersWithCookie(phCookie({ distinct_id: 'anon-123' })),
                    token,
                ),
            ).toBe('anon-123')
        })

        it('survives percent-escapes and non-ASCII inside nested values', () => {
            const cookie = phCookie({
                distinct_id: 'anon-123',
                $initial_person_info: {
                    r: 'https://x.test/?q=100%25 café',
                },
            })
            expect(
                readPosthogDistinctId(headersWithCookie(cookie), token),
            ).toBe('anon-123')
        })

        it('uses a readable duplicate when an earlier cookie of the same name is unreadable (and reports the bad one)', () => {
            const cookie = `${cookieName}=%7Bnope; ${phCookie({ distinct_id: 'anon-123' })}`
            expect(
                readPosthogDistinctId(headersWithCookie(cookie), token),
            ).toBe('anon-123')
            expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
        })

        it('ignores the _cpm metadata sidecar cookie and other tokens', () => {
            const sidecar = `${cookieName}_cpm=${encodeURIComponent(JSON.stringify({ p: [], f: 'x' }))}`
            expect(
                readPosthogDistinctId(headersWithCookie(sidecar), token),
            ).toBeNull()
            expect(
                readPosthogDistinctId(
                    headersWithCookie(phCookie({ distinct_id: 'anon-123' })),
                    'phc_other',
                ),
            ).toBeNull()
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })

        it('is null with no cookie header or no headers (and says nothing)', () => {
            expect(
                readPosthogDistinctId(headersWithCookie(null), token),
            ).toBeNull()
            expect(readPosthogDistinctId(null, token)).toBeNull()
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })
    })

    describe('documented no-id states (null, no Sentry warning)', () => {
        it('treats an empty snapshot as absent', () => {
            expect(
                readPosthogDistinctId(headersWithCookie(phCookie({})), token),
            ).toBeNull()
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })

        it('treats the cookieless-mode sentinel as absent (it is shared by every visitor)', () => {
            expect(
                readPosthogDistinctId(
                    headersWithCookie(
                        phCookie({ distinct_id: '$posthog_cookieless' }),
                    ),
                    token,
                ),
            ).toBeNull()
            expect(sentry.captureMessage).not.toHaveBeenCalled()
        })
    })

    describe('unreadable cookies (null + Sentry warning carrying a reason)', () => {
        it.each<[string, string, string]>([
            ['decode_error', `${cookieName}=%E0%A4%A`, 'decode_error'],
            ['json_error', `${cookieName}=%7Bnope`, 'json_error'],
            [
                'not_object (double-encoded value decodes to a JSON string)',
                phCookie(
                    encodeURIComponent(
                        JSON.stringify({ distinct_id: 'anon-123' }),
                    ),
                ),
                'not_object',
            ],
            [
                'distinct_id_missing',
                phCookie({ $device_id: 'd', $user_state: 'anonymous' }),
                'distinct_id_missing',
            ],
            [
                'distinct_id_not_string',
                phCookie({ distinct_id: 12345 }),
                'distinct_id_not_string',
            ],
            [
                'distinct_id_empty',
                phCookie({ distinct_id: '' }),
                'distinct_id_empty',
            ],
            [
                'distinct_id_too_long',
                phCookie({ distinct_id: 'x'.repeat(201) }),
                'distinct_id_too_long',
            ],
        ])('%s', (_label, cookie, reason) => {
            expect(
                readPosthogDistinctId(headersWithCookie(cookie), token),
            ).toBeNull()
            expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
            expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({
                level: 'warning',
                tags: { operation: 'posthog_distinct_id_cookie_parse' },
                extra: { reason },
            })
        })

        it('reports key NAMES and the JSON type, never values or the id', () => {
            readPosthogDistinctId(
                headersWithCookie(
                    phCookie({
                        distinct_id: 12345,
                        $device_id: 'SECRET-DEVICE-VALUE',
                    }),
                ),
                token,
            )
            const { extra } = lastReport()
            expect(extra.topLevelKeys).toEqual(['distinct_id', '$device_id'])
            expect(JSON.stringify(extra)).not.toMatch(
                /SECRET-DEVICE-VALUE|12345/,
            )

            readPosthogDistinctId(
                headersWithCookie(phCookie(['SECRET-ARRAY-VALUE'])),
                token,
            )
            const second = lastReport().extra
            expect(second).toMatchObject({
                reason: 'not_object',
                valueType: 'array',
            })
            expect(JSON.stringify(second)).not.toMatch(/SECRET-ARRAY-VALUE/)
        })

        it('caps the number and length of reported key names', () => {
            const many = Object.fromEntries(
                Array.from({ length: 50 }, (_, i) => [
                    `${'k'.repeat(100)}${i}`,
                    i,
                ]),
            )
            readPosthogDistinctId(headersWithCookie(phCookie(many)), token)
            const keys = lastReport().extra.topLevelKeys as string[]
            expect(keys).toHaveLength(20)
            expect(keys.every(key => key.length <= 40)).toBe(true)
        })

        it('records the raw cookie length', () => {
            const cookie = phCookie({ $device_id: 'd' })
            readPosthogDistinctId(headersWithCookie(cookie), token)
            expect(lastReport().extra.length).toBe(
                cookie.length - `${cookieName}=`.length,
            )
        })
    })
})
