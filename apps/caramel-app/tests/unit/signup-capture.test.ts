import {
    FIRST_TOUCH_COOKIE_NAME,
    serializeFirstTouchCookieValue,
    type FirstTouchRecord,
} from '@/lib/analytics/firstTouchRecord'
import {
    buildAcquisition,
    recordSignup,
    SIGNUP_ANALYTICS_TIMEOUT_MS,
} from '@/lib/auth/signupCapture'
import {
    classifySignupMethod,
    classifySignupSurface,
    handleUserCreated,
} from '@/lib/auth/signupHook'
import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The better-auth `databaseHooks.user.create.after` path. Every collaborator
// below is a TEST DOUBLE named for what it replaces (…Mock): the Prisma client,
// the posthog-node wrapper and Sentry. Nothing here talks to a database or to
// PostHog; the real-Postgres write of `users.acquisition` is covered by
// tests/integration/signup-acquisition.itest.ts.

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: { user: { updateMany: vi.fn() } },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { posthogServerMock } = vi.hoisted(() => ({
    posthogServerMock: {
        captureServerEvent: vi.fn(),
        aliasServerDistinctId: vi.fn(),
        getServerPosthogProjectToken: vi.fn(),
    },
}))
vi.mock('@/lib/analytics/posthogServer', () => posthogServerMock)

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: {
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
    },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

const TOKEN = 'phc_test_token'
const USER = { id: 'user_1' }

const firstTouch: FirstTouchRecord = {
    utm_source: 'reddit',
    utm_campaign: 'launch',
    gclid: 'g1',
    landing_path: '/',
    captured_at: '2026-10-01T12:00:00.000Z',
}

function cookieHeaders(
    parts: { firstTouch?: FirstTouchRecord; phDistinctId?: string } = {},
    extra: Record<string, string> = {},
): Headers {
    const cookies: string[] = []
    if (parts.firstTouch) {
        cookies.push(
            `${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(parts.firstTouch)}`,
        )
    }
    if (parts.phDistinctId) {
        cookies.push(
            `ph_${TOKEN}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: parts.phDistinctId }))}`,
        )
    }
    const headers = new Headers(extra)
    if (cookies.length) headers.set('cookie', cookies.join('; '))
    return headers
}

beforeEach(() => {
    prismaMock.user.updateMany.mockReset().mockResolvedValue({ count: 1 })
    posthogServerMock.captureServerEvent.mockReset().mockResolvedValue(true)
    posthogServerMock.aliasServerDistinctId.mockReset().mockResolvedValue(true)
    posthogServerMock.getServerPosthogProjectToken
        .mockReset()
        .mockReturnValue(TOKEN)
    for (const fn of Object.values(sentryMock)) fn.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('buildAcquisition', () => {
    it('keeps the whole first-touch record and adds the derived source + surface + method', () => {
        expect(
            buildAcquisition({ firstTouch, method: 'google', surface: 'web' }),
        ).toEqual({
            ...firstTouch,
            source: 'reddit',
            signup_surface: 'web',
            signup_method: 'google',
        })
    })

    it('a cookie with no campaign signal is "direct"', () => {
        const organic: FirstTouchRecord = {
            landing_path: '/',
            captured_at: '2026-10-01T12:00:00.000Z',
        }
        expect(
            buildAcquisition({
                firstTouch: organic,
                method: 'email',
                surface: 'web',
            }).source,
        ).toBe('direct')
    })

    it('no cookie at all is { source: "unknown", signup_surface } and nothing else', () => {
        expect(
            buildAcquisition({
                firstTouch: null,
                method: 'apple',
                surface: 'extension',
            }),
        ).toEqual({
            source: 'unknown',
            signup_surface: 'extension',
            signup_method: 'apple',
        })
    })
})

describe('recordSignup', () => {
    it('writes acquisition, captures signup_completed, and aliases the anonymous id', async () => {
        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ firstTouch, phDistinctId: 'anon-9' }),
            method: 'email',
            surface: 'web',
        })

        expect(outcome).toEqual({
            acquisitionSaved: true,
            eventCaptured: true,
            aliased: true,
        })
        expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
            // Write-once guard: only a row whose acquisition is still SQL NULL.
            where: { id: 'user_1', acquisition: { equals: Prisma.DbNull } },
            data: {
                acquisition: {
                    ...firstTouch,
                    source: 'reddit',
                    signup_surface: 'web',
                    signup_method: 'email',
                },
            },
        })
        const capture = posthogServerMock.captureServerEvent.mock.calls[0]![0]
        expect(capture).toMatchObject({
            event: 'signup_completed',
            distinctId: 'user_1',
            properties: {
                method: 'email',
                signup_surface: 'web',
                source: 'reddit',
                first_utm_source: 'reddit',
                first_gclid: 'g1',
            },
        })
        expect(capture.properties.$set_once).toMatchObject({
            acquisition_source: 'reddit',
            signup_method: 'email',
            first_utm_campaign: 'launch',
        })
        expect(posthogServerMock.aliasServerDistinctId).toHaveBeenCalledWith({
            anonymousDistinctId: 'anon-9',
            userId: 'user_1',
        })
    })

    it('no first-touch cookie: records source "unknown" with the surface, still captures', async () => {
        const outcome = await recordSignup({
            user: USER,
            headers: null,
            method: 'google',
            surface: 'extension',
        })

        expect(outcome.acquisitionSaved).toBe(true)
        expect(outcome.eventCaptured).toBe(true)
        expect(outcome.aliased).toBe(false)
        expect(prismaMock.user.updateMany.mock.calls[0]![0].data).toEqual({
            acquisition: {
                source: 'unknown',
                signup_surface: 'extension',
                signup_method: 'google',
            },
        })
        expect(
            posthogServerMock.captureServerEvent.mock.calls[0]![0],
        ).toMatchObject({
            properties: { source: 'unknown', signup_surface: 'extension' },
        })
        expect(posthogServerMock.aliasServerDistinctId).not.toHaveBeenCalled()
    })

    it('an invalid first-touch cookie is treated as absent, not as a failure', async () => {
        const outcome = await recordSignup({
            user: USER,
            headers: new Headers({
                cookie: `${FIRST_TOUCH_COOKIE_NAME}=%7Bbroken`,
            }),
            method: 'email',
            surface: 'web',
        })

        expect(outcome.acquisitionSaved).toBe(true)
        expect(
            prismaMock.user.updateMany.mock.calls[0]![0].data.acquisition
                .source,
        ).toBe('unknown')
        // Reported by the reader (firstTouchServer), not swallowed.
        expect(sentryMock.captureMessage).toHaveBeenCalledWith(
            expect.stringMatching(/first-touch cookie present but invalid/),
            expect.objectContaining({ level: 'warning' }),
        )
    })

    it('does not alias when the browser id already equals the user id', async () => {
        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ phDistinctId: 'user_1' }),
            method: 'email',
            surface: 'web',
        })
        expect(outcome.aliased).toBe(false)
        expect(posthogServerMock.aliasServerDistinctId).not.toHaveBeenCalled()
    })

    it('does not look for a PostHog cookie when server capture is disabled (no token)', async () => {
        posthogServerMock.getServerPosthogProjectToken.mockReturnValue(null)
        posthogServerMock.captureServerEvent.mockResolvedValue(false)

        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ phDistinctId: 'anon-9' }),
            method: 'email',
            surface: 'web',
        })

        expect(outcome).toEqual({
            acquisitionSaved: true,
            eventCaptured: false,
            aliased: false,
        })
        expect(posthogServerMock.aliasServerDistinctId).not.toHaveBeenCalled()
        // The disabled/failed capture leaves a breadcrumb instead of vanishing.
        expect(sentryMock.addBreadcrumb).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'signup_completed was not captured',
            }),
        )
    })

    it('is write-once: when acquisition is already set (count 0) it keeps the first record, is not an error, and still sends the event', async () => {
        prismaMock.user.updateMany.mockResolvedValue({ count: 0 })

        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ firstTouch }),
            method: 'google',
            surface: 'web',
        })

        expect(outcome).toMatchObject({
            acquisitionSaved: false,
            eventCaptured: true,
        })
        // Never an overwrite: a single guarded updateMany, no plain update.
        expect(prismaMock.user.updateMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.user.updateMany.mock.calls[0]![0].where).toEqual({
            id: 'user_1',
            acquisition: { equals: Prisma.DbNull },
        })
        expect(sentryMock.captureException).not.toHaveBeenCalled()
        expect(sentryMock.addBreadcrumb).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringMatching(/already set/),
            }),
        )
    })

    it('a failed DB write is reported and does NOT stop the PostHog event, and never throws', async () => {
        const dbError = new Error('connection reset')
        prismaMock.user.updateMany.mockRejectedValue(dbError)

        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ firstTouch }),
            method: 'email',
            surface: 'web',
        })

        expect(outcome).toMatchObject({
            acquisitionSaved: false,
            eventCaptured: true,
        })
        expect(sentryMock.captureException).toHaveBeenCalledWith(
            dbError,
            expect.objectContaining({
                tags: expect.objectContaining({ step: 'save_acquisition' }),
            }),
        )
    })

    it('a false from PostHog (it reported itself) is returned as eventCaptured:false, not thrown', async () => {
        posthogServerMock.captureServerEvent.mockResolvedValue(false)
        const outcome = await recordSignup({
            user: USER,
            headers: cookieHeaders({ firstTouch }),
            method: 'email',
            surface: 'web',
        })
        expect(outcome.eventCaptured).toBe(false)
        expect(outcome.acquisitionSaved).toBe(true)
    })

    it('a hung PostHog is cut off after the shared timeout so signup is not held up', async () => {
        vi.useFakeTimers()
        posthogServerMock.captureServerEvent.mockReturnValue(
            new Promise<boolean>(() => {}),
        )

        const pending = recordSignup({
            user: USER,
            headers: cookieHeaders({ firstTouch }),
            method: 'email',
            surface: 'web',
        })
        await vi.advanceTimersByTimeAsync(SIGNUP_ANALYTICS_TIMEOUT_MS + 1)
        const outcome = await pending

        expect(outcome.eventCaptured).toBe(false)
        expect(sentryMock.captureMessage).toHaveBeenCalledWith(
            expect.stringMatching(/"capture" timed out/),
            expect.objectContaining({ level: 'warning' }),
        )
    })

    it('an unexpected throw inside the analytics path is reported, never propagated', async () => {
        const boom = new Error('unexpected')
        posthogServerMock.captureServerEvent.mockImplementation(() => {
            throw boom
        })
        await expect(
            recordSignup({
                user: USER,
                headers: null,
                method: 'email',
                surface: 'web',
            }),
        ).resolves.toMatchObject({ eventCaptured: false })
        expect(sentryMock.captureException).toHaveBeenCalledWith(
            boom,
            expect.objectContaining({
                tags: expect.objectContaining({ step: 'record_signup' }),
            }),
        )
    })
})

describe('classifySignupMethod (which better-auth endpoint created the user)', () => {
    it.each([
        [{ path: '/sign-up/email' }, 'email'],
        [{ path: '/callback/:id', params: { id: 'google' } }, 'google'],
        [{ path: '/callback/:id', params: { id: 'apple' } }, 'apple'],
        [{ path: '/sign-in/social', body: { provider: 'google' } }, 'google'],
    ] as const)('%j -> %s', (context, expected) => {
        expect(classifySignupMethod(context)).toBe(expected)
    })

    it.each([
        ['no context at all (a script / direct adapter call)', null],
        ['an unknown path', { path: '/some/new-route' }],
        [
            'an OAuth callback for a provider we do not offer',
            { path: '/callback/:id', params: { id: 'github' } },
        ],
        [
            'a social sign-in with a junk body',
            { path: '/sign-in/social', body: 'x' },
        ],
    ])('%s -> unknown', (_label, context) => {
        expect(classifySignupMethod(context)).toBe('unknown')
    })
})

describe('classifySignupSurface', () => {
    it.each([
        'chrome-extension://abcdef',
        'moz-extension://1234-5678',
        'safari-web-extension://x',
    ])('Origin %s is the extension', origin => {
        expect(
            classifySignupSurface({ headers: new Headers({ origin }) }),
        ).toBe('extension')
    })

    it('a web Origin, no Origin, or no context is web', () => {
        expect(
            classifySignupSurface({
                headers: new Headers({ origin: 'https://grabcaramel.com' }),
            }),
        ).toBe('web')
        expect(classifySignupSurface({ headers: new Headers() })).toBe('web')
        expect(classifySignupSurface(null)).toBe('web')
    })
})

describe('handleUserCreated (the hook better-auth calls)', () => {
    it('reads the cookie off the request context and records the signup', async () => {
        const outcome = await handleUserCreated(USER, {
            path: '/callback/:id',
            params: { id: 'google' },
            headers: cookieHeaders({ firstTouch }),
        })

        expect(outcome).toEqual({
            acquisitionSaved: true,
            eventCaptured: true,
            aliased: false,
        })
        expect(
            prismaMock.user.updateMany.mock.calls[0]![0].data.acquisition,
        ).toMatchObject({
            source: 'reddit',
            signup_method: 'google',
            signup_surface: 'web',
        })
    })

    it('an extension-origin email signup is recorded as surface "extension"', async () => {
        await handleUserCreated(USER, {
            path: '/sign-up/email',
            headers: cookieHeaders({}, { origin: 'chrome-extension://abc' }),
        })
        expect(
            prismaMock.user.updateMany.mock.calls[0]![0].data.acquisition,
        ).toMatchObject({ signup_surface: 'extension', signup_method: 'email' })
    })

    it('with no request context (null) still writes {source:"unknown"} and warns about the unclassified path', async () => {
        await handleUserCreated(USER, null)
        expect(
            prismaMock.user.updateMany.mock.calls[0]![0].data.acquisition,
        ).toEqual({
            source: 'unknown',
            signup_surface: 'web',
            signup_method: 'unknown',
        })
        expect(sentryMock.captureMessage).toHaveBeenCalledWith(
            'user created through an unclassified better-auth path',
            expect.objectContaining({ level: 'warning' }),
        )
    })

    it('analytics failure never reaches better-auth (the signup response is not failed)', async () => {
        prismaMock.user.updateMany.mockRejectedValue(new Error('db down'))
        posthogServerMock.captureServerEvent.mockRejectedValue(
            new Error('posthog down'),
        )
        await expect(
            handleUserCreated(USER, {
                path: '/sign-up/email',
                headers: cookieHeaders({ firstTouch }),
            }),
        ).resolves.toMatchObject({
            acquisitionSaved: false,
            eventCaptured: false,
        })
    })
})
