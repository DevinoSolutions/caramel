// tests/unit/stable-user-id.test.ts
//
// ONE user id across PostHog, Sentry and Postgres. Before this landed,
// `grep setUser` over the whole repo returned nothing: Sentry knew the PostHog
// distinct id only as a free-text context blob, so no issue was attributable to
// an account and "users affected" was always zero.
//
// Pinned here because the failure is silent — nothing breaks, errors just stop
// being traceable to a person, which is exactly the class of gap the
// paid-user-watch review exists to catch.
import { setSentryUser } from '@/lib/analytics/identity'
import { withRoute } from '@/lib/api/withRoute'
import { NextResponse, type NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setUser = vi.fn()

vi.mock('@sentry/nextjs', () => ({
    setUser: (...args: unknown[]) => setUser(...args),
    setTag: vi.fn(),
    setContext: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn(),
}))

vi.mock('posthog-js', () => ({
    default: {
        init: vi.fn(),
        identify: vi.fn(),
        reset: vi.fn(),
        register: vi.fn(),
        get_session_id: () => 'sess',
        get_distinct_id: () => 'distinct',
    },
}))

const getSession = vi.fn()
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}))

function request(): NextRequest {
    return new Request('https://grabcaramel.com/api/account/overview', {
        method: 'GET',
    }) as unknown as NextRequest
}

describe('one stable user id', () => {
    beforeEach(() => {
        setUser.mockClear()
        getSession.mockReset()
    })

    it('setSentryUser sends the id alone, never an email or name', () => {
        setSentryUser('M02KFmXCsRqnVFSvUKzNkbogYGxBz47Q')

        expect(setUser).toHaveBeenCalledWith({
            id: 'M02KFmXCsRqnVFSvUKzNkbogYGxBz47Q',
        })
        const [payload] = setUser.mock.calls[0] as [Record<string, unknown>]
        expect(Object.keys(payload)).toEqual(['id'])
    })

    it('setSentryUser(null) clears the field on logout', () => {
        setSentryUser(null)
        expect(setUser).toHaveBeenCalledWith(null)
    })

    it('withRoute attributes an authenticated request to the DB user id', async () => {
        getSession.mockResolvedValue({
            user: { id: 'NB2nvSoR5BqwRi7LhTWu1MygoDMmOzEG' },
        })
        const handler = withRoute(
            { method: 'GET', routeName: 'test/session', auth: 'session' },
            async () => NextResponse.json({ ok: true }),
        )

        const res = await handler(request())

        expect(res.status).toBe(200)
        expect(setUser).toHaveBeenCalledWith({
            id: 'NB2nvSoR5BqwRi7LhTWu1MygoDMmOzEG',
        })
    })

    it('withRoute clears the user for an anonymous optional-auth request', async () => {
        getSession.mockResolvedValue(null)
        const handler = withRoute(
            { method: 'GET', routeName: 'test/optional', auth: 'optional' },
            async () => NextResponse.json({ ok: true }),
        )

        const res = await handler(request())

        expect(res.status).toBe(200)
        expect(setUser).toHaveBeenCalledWith(null)
    })
})
