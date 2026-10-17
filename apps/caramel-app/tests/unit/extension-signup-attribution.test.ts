import { firstTouchRecordSchema } from '@/lib/analytics/firstTouchRecord'
import {
    extensionAttributionFromQuery,
    resolveExtensionAttribution,
} from '@/lib/auth/extensionSignupAttribution'
import { INSTALL_ID_PATTERN } from '@/lib/extensionInstall'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The OPTIONAL install id + first-touch record an extension build sends with
// its sign-in. Contract under test: valid -> used, absent -> nothing and no
// noise (old builds), invalid -> dropped with a Sentry WARNING (never a throw,
// never a 400). Sentry is the one test double; the schema and the install-id
// pattern are the real shared definitions.

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureMessage: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

const IID = '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01'
const record = {
    utm_source: 'reddit',
    utm_medium: 'social',
    referrer_domain: 'reddit.com',
    landing_path: '/honey-extension',
    captured_at: '2026-10-01T12:00:00.000Z',
}

beforeEach(() => {
    sentryMock.captureMessage.mockReset()
})

describe('resolveExtensionAttribution', () => {
    it('the fixtures are real (guards the tests below)', () => {
        expect(INSTALL_ID_PATTERN.test(IID)).toBe(true)
        expect(firstTouchRecordSchema.safeParse(record).success).toBe(true)
    })

    it('valid iid and record are returned and nothing is reported', () => {
        expect(
            resolveExtensionAttribution(
                { iid: IID, firstTouch: record },
                'oauth_body',
            ),
        ).toEqual({ installId: IID, firstTouch: record })
        expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('absent fields (an old build) are nothing, silently', () => {
        expect(resolveExtensionAttribution({}, 'oauth_body')).toEqual({
            installId: null,
            firstTouch: null,
        })
        expect(
            resolveExtensionAttribution(
                { iid: undefined, firstTouch: null },
                'oauth_body',
            ),
        ).toEqual({ installId: null, firstTouch: null })
        expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it.each([
        ['a number', 42],
        ['not a uuid', 'abc'],
        ['an injection attempt', "'; drop table users; --"],
    ])('an install id that is %s is dropped with a warning', (_, iid) => {
        expect(
            resolveExtensionAttribution(
                { iid, firstTouch: record },
                'oauth_body',
            ),
        ).toEqual({ installId: null, firstTouch: record })
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
        expect(sentryMock.captureMessage).toHaveBeenCalledWith(
            'extension sign-in attribution field invalid; dropped',
            expect.objectContaining({
                level: 'warning',
                extra: expect.objectContaining({ field: 'iid' }),
            }),
        )
    })

    it.each([
        ['a string', 'reddit'],
        ['missing captured_at', { utm_source: 'reddit' }],
        ['an over-long label', { ...record, utm_source: 'x'.repeat(256) }],
        ['a wrong-typed label', { ...record, ref: 5 }],
    ])(
        'a first-touch record that is %s is dropped with a warning',
        (_, bad) => {
            expect(
                resolveExtensionAttribution(
                    { iid: IID, firstTouch: bad },
                    'oauth_body',
                ),
            ).toEqual({ installId: IID, firstTouch: null })
            expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
            expect(sentryMock.captureMessage).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    extra: expect.objectContaining({ field: 'firstTouch' }),
                }),
            )
        },
    )

    it('unknown keys on the record are stripped, as the cookie reader does', () => {
        const result = resolveExtensionAttribution(
            { firstTouch: { ...record, evil: 'x' } },
            'oauth_body',
        )
        expect(result.firstTouch).toEqual(record)
    })

    it('the warning carries the reason, never the offending value', () => {
        resolveExtensionAttribution(
            { iid: 'secret-looking-value' },
            'oauth_body',
        )
        expect(
            JSON.stringify(sentryMock.captureMessage.mock.calls),
        ).not.toContain('secret-looking-value')
    })
})

describe('extensionAttributionFromQuery (the Safari authorize call)', () => {
    it('reads iid and the JSON ft', () => {
        const params = new URLSearchParams({
            iid: IID,
            ft: JSON.stringify(record),
        })
        expect(extensionAttributionFromQuery(params)).toEqual({
            installId: IID,
            firstTouch: record,
        })
    })

    it('neither param present is nothing, silently', () => {
        expect(extensionAttributionFromQuery(new URLSearchParams())).toEqual({
            installId: null,
            firstTouch: null,
        })
        expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('an ft that is not JSON is dropped with a warning, iid still used', () => {
        const params = new URLSearchParams({ iid: IID, ft: '{broken' })
        expect(extensionAttributionFromQuery(params)).toEqual({
            installId: IID,
            firstTouch: null,
        })
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
    })
})
