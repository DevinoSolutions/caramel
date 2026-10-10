import { POST as loginPOST } from '@/app/api/extension/login/route'
import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two extension auth routes used to hide handler errors:
// login/route.ts had a fully silent `catch {}` (no log, no Sentry) and
// authorize/route.ts had a `console.error`-only 500 that bypassed Sentry and
// leaked error.message into the body. Both now route every uncaught handler
// error through handleRouteError — Sentry.captureException + an x-request-id —
// exactly like every other route.ts. This pins that both error paths reach
// Sentry AND return the intended status/body. Mirrors handleRouteError.test.ts's
// Sentry-spy pattern.
const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: captureExceptionMock }))

// authorize/route.ts captures env.EXTENSION_OAUTH_STATE_SECRET into a
// module-top-level `const` at import time (same closure-timing hazard
// documented in route-pipeline.test.ts). Leaving it undefined in the hoisted
// initial object makes createSignedState() throw on the otherwise-happy path —
// precisely the uncaught-in-handler error we want to prove now reaches Sentry.
const { envMock } = vi.hoisted(() => ({
    envMock: {
        EXTENSION_OAUTH_STATE_SECRET: undefined as string | undefined,
        GOOGLE_CLIENT_ID: 'test-google-client-id' as string | undefined,
        APPLE_CLIENT_ID: 'test-apple-client-id' as string | undefined,
        BETTER_AUTH_URL: 'https://localhost:58000' as string | undefined,
        CHROME_EXTENSION_ORIGIN: undefined as string | undefined,
        FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
        SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://localhost:58000' }))

// Mock better-auth's `auth` object so login/route.ts never loads the real
// better-auth graph (prisma adapter, bcrypt, email templates) and so we can
// make signInEmail throw on demand.
const { signInEmailMock } = vi.hoisted(() => ({ signInEmailMock: vi.fn() }))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { signInEmail: signInEmailMock } },
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

beforeEach(() => {
    captureExceptionMock.mockClear()
    signInEmailMock.mockReset()
})

describe('extension/login — a handler throw now reaches Sentry', () => {
    it('signInEmail rejecting -> 500 {error:"Internal server error"} + Sentry.captureException + x-request-id (was a silent catch {})', async () => {
        const boom = new Error('better-auth exploded')
        signInEmailMock.mockRejectedValue(boom)

        const req = new NextRequest('http://localhost/api/extension/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                email: 'user@example.com',
                password: 'secret',
            }),
        })
        const res = await loginPOST(req)

        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Internal server error' })
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        expect(captureExceptionMock.mock.calls[0][0]).toBe(boom)
    })
})

describe('extension/oauth/authorize — a handler throw now reaches Sentry', () => {
    it('createSignedState throwing -> 500 {error:"Internal server error while getting OAuth URL"} + Sentry.captureException + x-request-id (was console.error only)', async () => {
        const url = new URL('http://localhost/api/extension/oauth/authorize')
        url.searchParams.set('provider', 'google')
        url.searchParams.set(
            'redirect_uri',
            'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/',
        )

        const res = await authorizeGET(new NextRequest(url))

        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({
            error: 'Internal server error while getting OAuth URL',
        })
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    })
})
