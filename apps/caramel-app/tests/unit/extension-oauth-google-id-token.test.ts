import { POST } from '@/app/api/extension/oauth/google-id-token/route'
import { mintExtensionSession } from '@/lib/auth/extensionOAuthSession'
import { verifyGoogleIdToken } from '@/lib/auth/googleIdToken'
import {
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
    type JWTVerifyGetKey,
} from 'jose'
import { NextRequest } from 'next/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Native Google sign-in for the Android app: Credential Manager hands the app
// a Google ID token (aud = our web client) and the app trades it at
// POST /api/extension/oauth/google-id-token for the same bearer the code
// flow mints.
//
// Doubles: Google's REMOTE key set is swapped for a LOCAL one holding a key
// generated here, so verifyGoogleIdToken runs jose's real signature and claim
// checks against tokens this file signs. mintExtensionSession is pinned on
// its own in extensionOAuthSession.test.ts; env, rate limit and Sentry are
// stand-ins as in extension-oauth-app-redirect.test.ts.

const { envMock, keys } = vi.hoisted(() => ({
    envMock: {
        GOOGLE_CLIENT_ID: 'web-client.apps.googleusercontent.com' as
            string | undefined,
    },
    keys: { current: null as JWTVerifyGetKey | null },
}))
vi.mock('jose', async importOriginal => {
    const actual = await importOriginal<typeof import('jose')>()
    return {
        ...actual,
        createRemoteJWKSet: () =>
            ((...args: Parameters<JWTVerifyGetKey>) =>
                keys.current!(...args)) as JWTVerifyGetKey,
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: vi.fn(async () => null) } },
}))
vi.mock('@/lib/auth/extensionOAuthSession', () => ({
    mintExtensionSession: vi.fn(async () => ({
        token: 'session-token',
        username: 'Google User',
        image: null,
    })),
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
}))

const AUD = 'web-client.apps.googleusercontent.com'
let privateKey: CryptoKey
let otherPrivateKey: CryptoKey

beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    const other = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    otherPrivateKey = other.privateKey
    const jwk = {
        ...(await exportJWK(pair.publicKey)),
        kid: 'k1',
        alg: 'RS256',
    }
    keys.current = createLocalJWKSet({ keys: [jwk] })
})

beforeEach(() => {
    vi.mocked(mintExtensionSession).mockClear()
    envMock.GOOGLE_CLIENT_ID = AUD
})

function googleToken(
    claims: Record<string, unknown> = {},
    opts: {
        aud?: string
        iss?: string
        exp?: string | number
        key?: CryptoKey
    } = {},
) {
    return new SignJWT({
        email: 'Shopper@Example.com',
        email_verified: true,
        name: 'Shopper',
        picture: 'https://lh3.googleusercontent.com/a/x',
        ...claims,
    })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('109876543210')
        .setIssuer(opts.iss ?? 'https://accounts.google.com')
        .setAudience(opts.aud ?? AUD)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(opts.key ?? privateKey)
}

function post(body: unknown) {
    return POST(
        new NextRequest(
            'https://grabcaramel.test/api/extension/oauth/google-id-token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
        ),
    )
}

describe('verifyGoogleIdToken', () => {
    it('returns the claims of a valid token, email normalized', async () => {
        await expect(
            verifyGoogleIdToken(await googleToken(), AUD),
        ).resolves.toEqual({
            sub: '109876543210',
            email: 'shopper@example.com',
            emailVerified: true,
            name: 'Shopper',
            picture: 'https://lh3.googleusercontent.com/a/x',
        })
    })

    it('accepts the bare accounts.google.com issuer Google also uses', async () => {
        const token = await googleToken({}, { iss: 'accounts.google.com' })
        await expect(verifyGoogleIdToken(token, AUD)).resolves.not.toBeNull()
    })

    it.each([
        [
            'another audience',
            { aud: 'someone-else.apps.googleusercontent.com' },
        ],
        ['another issuer', { iss: 'https://evil.example' }],
        ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ])('refuses %s', async (_label, opts) => {
        await expect(
            verifyGoogleIdToken(await googleToken({}, opts), AUD),
        ).resolves.toBeNull()
    })

    it('refuses a token signed by a key Google does not publish', async () => {
        const token = await googleToken({}, { key: otherPrivateKey })
        await expect(verifyGoogleIdToken(token, AUD)).resolves.toBeNull()
    })

    it('refuses something that is not a JWT', async () => {
        await expect(verifyGoogleIdToken('not-a-jwt', AUD)).resolves.toBeNull()
    })

    it('reads email_verified only as a real boolean true', async () => {
        const claims = await verifyGoogleIdToken(
            await googleToken({ email_verified: 'true' }),
            AUD,
        )
        expect(claims?.emailVerified).toBe(false)
    })

    it('throws (does not refuse the token) when the key set cannot be read', async () => {
        const saved = keys.current
        keys.current = async () => {
            throw new TypeError('fetch failed')
        }
        try {
            await expect(
                verifyGoogleIdToken(await googleToken(), AUD),
            ).rejects.toThrow('fetch failed')
        } finally {
            keys.current = saved
        }
    })
})

describe('POST /api/extension/oauth/google-id-token', () => {
    it('mints the session for a valid, verified token', async () => {
        const idToken = await googleToken()
        const res = await post({ idToken })
        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            token: 'session-token',
            username: 'Google User',
            image: null,
        })
        expect(mintExtensionSession).toHaveBeenCalledWith({
            provider: 'google',
            providerUser: {
                id: '109876543210',
                email: 'shopper@example.com',
                name: 'Shopper',
                image: 'https://lh3.googleusercontent.com/a/x',
                emailVerified: true,
            },
            tokens: { idToken },
        })
    })

    it('answers 401 and mints nothing for an invalid token', async () => {
        const res = await post({
            idToken: await googleToken({}, { aud: 'other-client' }),
        })
        expect(res.status).toBe(401)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 403 for an unverified Google email', async () => {
        const res = await post({
            idToken: await googleToken({ email_verified: false }),
        })
        expect(res.status).toBe(403)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 400 for a token with no email', async () => {
        const res = await post({
            idToken: await googleToken({ email: undefined }),
        })
        expect(res.status).toBe(400)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 422 for a body without an idToken', async () => {
        const res = await post({})
        expect(res.status).toBe(422)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 500 when Google OAuth is not configured', async () => {
        envMock.GOOGLE_CLIENT_ID = undefined
        const res = await post({ idToken: await googleToken() })
        expect(res.status).toBe(500)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })
})
