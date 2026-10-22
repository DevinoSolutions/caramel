import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sign in with Apple token revocation on account deletion (T-5065, App Review
// 5.1.1(v)). What this file keeps true:
//   1. An Apple account -> ONE form POST to appleid.apple.com/auth/revoke with
//      client_id, client_secret, the DECRYPTED token and the matching hint;
//      refresh token preferred, access token the fallback.
//   2. No Apple account -> no call at all.
//   3. A refusal / transport failure / unusable row is never silent: it reaches
//      Sentry with a reason (and never a token value) and comes back `failed`.
// Token encryption itself is oauth-token-crypto.test.ts; the real module runs
// here so the stored value is genuinely ciphertext.

const envMock = vi.hoisted(() => ({
    APPLE_CLIENT_ID: 'com.test.signin' as string | undefined,
    BETTER_AUTH_SECRET: 'test-auth-secret' as string | undefined,
    JWT_SECRET: undefined as string | undefined,
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

// TEST DOUBLE: the real helper signs an ES256 JWT with a .p8 key (covered by
// apple-client-secret.test.ts); here only "the helper's output is what is sent".
vi.mock('@/lib/auth/appleClientSecret', () => ({
    getAppleClientSecret: vi.fn(() => 'signed-client-secret'),
}))

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: { account: { findMany: vi.fn() } },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: captureExceptionMock }))

import { getAppleClientSecret } from '@/lib/auth/appleClientSecret'
import {
    APPLE_REVOKE_URL,
    loadAppleRevocationTargets,
    revokeAppleGrants,
} from '@/lib/auth/appleTokenRevocation'
import { encryptOAuthToken } from '@/lib/auth/oauthTokenCrypto'

const REFRESH = 'r.refresh-token-value.0.abc'
const ACCESS = 'a.access-token-value.0.xyz'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
    vi.clearAllMocks()
    envMock.APPLE_CLIENT_ID = 'com.test.signin'
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function sentForm(call = 0): URLSearchParams {
    const init = fetchMock.mock.calls[call]![1]!
    return new URLSearchParams(init.body as URLSearchParams)
}

function captured(): { error: Error; hint: Record<string, unknown> }[] {
    return captureExceptionMock.mock.calls.map(([error, hint]) => ({
        error: error as Error,
        hint: hint as Record<string, unknown>,
    }))
}

describe('loadAppleRevocationTargets', () => {
    it("reads only this user's apple account rows", async () => {
        prismaMock.account.findMany.mockResolvedValue([])

        await loadAppleRevocationTargets('user-1')

        expect(prismaMock.account.findMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', providerId: 'apple' },
            select: { refreshToken: true, accessToken: true },
        })
    })
})

describe('revokeAppleGrants', () => {
    it('apple user: POSTs the form to /auth/revoke with the decrypted refresh token', async () => {
        const outcome = await revokeAppleGrants([
            {
                refreshToken: await encryptOAuthToken(REFRESH),
                accessToken: await encryptOAuthToken(ACCESS),
            },
        ])

        expect(outcome).toBe('revoked')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]!
        expect(url).toBe(APPLE_REVOKE_URL)
        expect(url).toBe('https://appleid.apple.com/auth/revoke')
        expect(init?.method).toBe('POST')
        expect(init?.headers).toEqual({
            'Content-Type': 'application/x-www-form-urlencoded',
        })
        expect(Object.fromEntries(sentForm())).toEqual({
            client_id: 'com.test.signin',
            client_secret: 'signed-client-secret',
            token: REFRESH,
            token_type_hint: 'refresh_token',
        })
        expect(captureExceptionMock).not.toHaveBeenCalled()
    })

    it('reads a refresh token that was stored in plain text before encryption was enabled', async () => {
        await revokeAppleGrants([{ refreshToken: REFRESH, accessToken: null }])

        expect(sentForm().get('token')).toBe(REFRESH)
    })

    it('falls back to the access token (hint access_token) when no refresh token was stored', async () => {
        const outcome = await revokeAppleGrants([
            { refreshToken: null, accessToken: ACCESS },
        ])

        expect(outcome).toBe('revoked')
        expect(Object.fromEntries(sentForm())).toMatchObject({
            token: ACCESS,
            token_type_hint: 'access_token',
        })
    })

    it('no Apple account: no call, nothing reported', async () => {
        const outcome = await revokeAppleGrants([])

        expect(outcome).toBe('not_applicable')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(captureExceptionMock).not.toHaveBeenCalled()
    })

    it('Apple answers non-2xx: Sentry gets the status and Apple error code, never the token; outcome is failed', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: 'invalid_client' }), {
                status: 400,
            }),
        )

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        const [report] = captured()
        expect(report!.error.message).toBe(
            'Apple token revocation failed: apple_rejected',
        )
        expect(report!.hint).toEqual({
            level: 'error',
            tags: {
                route: 'account/delete',
                provider: 'apple',
                reason: 'apple_rejected',
            },
            extra: {
                hint: 'refresh_token',
                status: 400,
                appleError: 'invalid_client',
            },
        })
        expect(JSON.stringify(captureExceptionMock.mock.calls)).not.toContain(
            REFRESH,
        )
    })

    it('Apple answers non-2xx with a body that is not JSON: still reported, error code says so', async () => {
        fetchMock.mockResolvedValue(
            new Response('<html>502</html>', { status: 502 }),
        )

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(captured()[0]!.hint).toMatchObject({
            extra: { status: 502, appleError: 'unparseable_body' },
        })
    })

    it('transport failure (timeout, DNS): reported with the cause message, outcome is failed', async () => {
        const cause = new TypeError('fetch failed')
        fetchMock.mockRejectedValue(cause)

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        const [report] = captured()
        expect(report!.error.message).toBe(
            'Apple token revocation failed: request_not_completed',
        )
        expect(report!.hint).toMatchObject({
            extra: { hint: 'refresh_token', cause: 'fetch failed' },
        })
    })

    it('a stored token that no longer decrypts is reported and makes no call', async () => {
        const stored = (await encryptOAuthToken(REFRESH)) as string
        envMock.BETTER_AUTH_SECRET = 'rotated-secret'

        const outcome = await revokeAppleGrants([
            { refreshToken: stored, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(captured()[0]!.hint).toMatchObject({
            tags: { reason: 'request_not_completed' },
        })
    })

    it('a failing client-secret signer is reported, not thrown', async () => {
        vi.mocked(getAppleClientSecret).mockImplementationOnce(() => {
            throw new Error('APPLE_PRIVATE_KEY is not a valid PKCS#8 P-256 PEM')
        })

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(captured()).toHaveLength(1)
    })

    it('an Apple account row with no token at all is reported (nothing can be revoked)', async () => {
        const outcome = await revokeAppleGrants([
            { refreshToken: null, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(captured()[0]!.hint).toMatchObject({
            tags: { reason: 'no_token_stored' },
        })
    })

    it('Apple not configured on this deploy: reported, no call', async () => {
        envMock.APPLE_CLIENT_ID = undefined

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(captured()[0]!.hint).toMatchObject({
            tags: { reason: 'apple_not_configured' },
        })
    })

    it('several Apple rows: each is revoked; one refusal makes the outcome failed but does not stop the others', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: 'invalid_grant' }), {
                    status: 400,
                }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 200 }))

        const outcome = await revokeAppleGrants([
            { refreshToken: REFRESH, accessToken: null },
            { refreshToken: 'r.second.0.def', accessToken: null },
        ])

        expect(outcome).toBe('failed')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(captured()).toHaveLength(1)
    })
})
