import { POST as handoff } from '@/app/api/app/web-session/handoff/route'
import { GET as redeem } from '@/app/api/app/web-session/redeem/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two T-7852 web-session routes themselves (web-session-handoff.test.ts
// only checks a copy of the handoff's next-path schema).
//
// /redeem signs a browser in as whoever minted the code, so only the native
// shell may redeem: a redeem link opened in an ordinary browser would sign the
// shopper in to the account of the person who sent it. /handoff skips
// withRoute for its bearer-only check, so it caps its own body.

// MOCK (announced): the database, the session lookup and the rate limiter.
// What they are asked, and whether they are asked at all, is what these tests
// measure.
const { envMock, queryRawMock, findSessionMock, createMock, getSessionMock } =
    vi.hoisted(() => ({
        envMock: {} as Record<string, unknown>,
        queryRawMock: vi.fn(
            async (..._args: unknown[]): Promise<unknown[]> => [],
        ),
        findSessionMock: vi.fn(
            async (_args: unknown): Promise<unknown> => null,
        ),
        createMock: vi.fn(async (_args: unknown) => ({})),
        getSessionMock: vi.fn(
            async (_opts: { headers: Headers }): Promise<unknown> => null,
        ),
    }))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRawMock,
        session: { findUnique: findSessionMock },
        verification: { create: createMock },
    },
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: vi.fn(async () => null),
}))

const SHELL_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 CaramelApp/1.6.0 (android)'
const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const CODE = 'a'.repeat(43)

function redeemRequest(headers: Record<string, string>) {
    return new NextRequest(
        `https://grabcaramel.com/api/app/web-session/redeem?code=${CODE}`,
        { headers },
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    envMock.BETTER_AUTH_URL = 'https://grabcaramel.com'
    envMock.BETTER_AUTH_SECRET = 'test-secret'
    queryRawMock.mockResolvedValue([
        {
            value: JSON.stringify({ sessionId: 's1', next: '/profile' }),
            expiresAt: new Date(Date.now() + 30_000),
        },
    ])
    findSessionMock.mockResolvedValue({
        id: 's1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86_400_000),
    })
})

describe('GET /api/app/web-session/redeem', () => {
    it('signs the shell in and lands on the stored page', async () => {
        const res = await redeem(
            redeemRequest({ 'user-agent': SHELL_UA, 'sec-fetch-site': 'none' }),
        )
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe('/profile')
        expect(res.headers.get('set-cookie')).toContain(
            'better-auth.session_token=tok.',
        )
        expect(queryRawMock).toHaveBeenCalledTimes(1)
    })

    it('refuses an ordinary browser without touching the code', async () => {
        // The login-CSRF case: someone mints a code from their own account
        // and sends the link; opening it must not sign the shopper in as them.
        const res = await redeem(
            redeemRequest({
                'user-agent': BROWSER_UA,
                'sec-fetch-site': 'none',
            }),
        )
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe('/login?error=handoff_expired')
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(queryRawMock).not.toHaveBeenCalled()
    })

    it('refuses a shell user agent sent from another site', async () => {
        const res = await redeem(
            redeemRequest({
                'user-agent': SHELL_UA,
                'sec-fetch-site': 'cross-site',
            }),
        )
        expect(res.headers.get('location')).toBe('/login?error=handoff_expired')
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(queryRawMock).not.toHaveBeenCalled()
    })

    it('refuses a request with no user agent at all', async () => {
        const res = await redeem(redeemRequest({}))
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(queryRawMock).not.toHaveBeenCalled()
    })
})

const post = (body: string) =>
    handoff(
        new NextRequest('https://grabcaramel.com/api/app/web-session/handoff', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body,
        }),
    )

describe('POST /api/app/web-session/handoff', () => {
    beforeEach(() => {
        getSessionMock.mockResolvedValue({ session: { id: 's1' } })
    })

    it('mints a redeem URL for a valid bearer and next path', async () => {
        const res = await post(JSON.stringify({ next: '/profile' }))
        expect(res.status).toBe(200)
        const json = (await res.json()) as { url: string }
        expect(json.url).toMatch(
            /^https:\/\/grabcaramel\.com\/api\/app\/web-session\/redeem\?code=[\w-]{43}$/,
        )
        expect(createMock).toHaveBeenCalledTimes(1)
    })

    it('answers 413 to a body over the cap and writes nothing', async () => {
        const res = await post(
            JSON.stringify({ next: '/profile', pad: 'x'.repeat(8 * 1024) }),
        )
        expect(res.status).toBe(413)
        expect(createMock).not.toHaveBeenCalled()
    })

    it('still answers 401 to a missing bearer before reading the body', async () => {
        const res = await handoff(
            new NextRequest(
                'https://grabcaramel.com/api/app/web-session/handoff',
                { method: 'POST', body: JSON.stringify({ next: '/' }) },
            ),
        )
        expect(res.status).toBe(401)
        expect(getSessionMock).not.toHaveBeenCalled()
    })
})
