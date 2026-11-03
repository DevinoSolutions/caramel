import { POST } from '@/app/api/extension/oauth/apple-id-token/route'
import {
    appleNonceHash,
    redeemAppleNativeCode,
    verifyAppleNativeIdToken,
} from '@/lib/auth/appleNativeSignIn'
import {
    ExtensionOAuthEmailRequiredError,
    mintExtensionSession,
} from '@/lib/auth/extensionOAuthSession'
import {
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
    type JWTVerifyGetKey,
} from 'jose'
import { NextRequest } from 'next/server'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// Native Sign in with Apple for the iOS app: Apple's sheet hands the app an
// identity token (aud = the bundle id, nonce = SHA-256 of the app's raw
// nonce) and a one-time code, and the app trades them at
// POST /api/extension/oauth/apple-id-token for the same bearer the code flow
// mints.
//
// Doubles: Apple's REMOTE key set is swapped for a LOCAL one holding a key
// generated here, so jose's real signature and claim checks run against
// tokens this file signs. The client-secret signer is a stand-in (it is
// apple-client-secret.test.ts's subject), Apple's token endpoint is a stubbed
// fetch, and mintExtensionSession is pinned on its own in
// extensionOAuthSession.test.ts.

const { envMock, keys, captureExceptionMock } = vi.hoisted(() => ({
    envMock: {
        APPLE_CLIENT_ID: 'com.devino.caramel.signin' as string | undefined,
    },
    keys: { current: null as JWTVerifyGetKey | null },
    captureExceptionMock: vi.fn(),
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
// TEST DOUBLE: the real signer needs a .p8 key.
vi.mock('@/lib/auth/appleClientSecret', () => ({
    getAppleClientSecret: vi.fn(() => 'signed-client-secret'),
}))
// TEST DOUBLE: the real module opens the generated Prisma client; the route
// only needs the mint call and the email-required error class.
vi.mock('@/lib/auth/extensionOAuthSession', () => ({
    ExtensionOAuthEmailRequiredError: class extends Error {},
    mintExtensionSession: vi.fn(async () => ({
        token: 'session-token',
        username: 'Apple User',
        image: null,
    })),
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage: vi.fn(),
    captureException: captureExceptionMock,
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
}))

const BUNDLE_ID = 'com.devino.Caramel'
const RAW_NONCE = 'a-raw-nonce-of-32-characters-xyz'
const fetchMock = vi.fn<typeof fetch>()
let privateKey: CryptoKey
let otherPrivateKey: CryptoKey

beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    const other = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    otherPrivateKey = other.privateKey
    const jwk = {
        ...(await exportJWK(pair.publicKey)),
        kid: 'apple-1',
        alg: 'RS256',
    }
    keys.current = createLocalJWKSet({ keys: [jwk] })
})

beforeEach(() => {
    vi.clearAllMocks()
    envMock.APPLE_CLIENT_ID = 'com.devino.caramel.signin'
    fetchMock.mockResolvedValue(
        Response.json({
            access_token: 'apple-access',
            refresh_token: 'apple-refresh',
            id_token: 'ignored',
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function appleToken(
    claims: Record<string, unknown> = {},
    opts: {
        aud?: string
        iss?: string
        exp?: string | number
        key?: CryptoKey
    } = {},
) {
    return new SignJWT({
        email: 'Shopper@privaterelay.appleid.com',
        email_verified: 'true',
        is_private_email: 'true',
        nonce: appleNonceHash(RAW_NONCE),
        nonce_supported: true,
        ...claims,
    })
        .setProtectedHeader({ alg: 'RS256', kid: 'apple-1' })
        .setSubject('001234.abcdef.1234')
        .setIssuer(opts.iss ?? 'https://appleid.apple.com')
        .setAudience(opts.aud ?? BUNDLE_ID)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(opts.key ?? privateKey)
}

function post(body: unknown) {
    return POST(
        new NextRequest(
            'https://grabcaramel.test/api/extension/oauth/apple-id-token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
        ),
    )
}

describe('verifyAppleNativeIdToken', () => {
    it('returns the claims of a valid token for the app, email normalized', async () => {
        await expect(
            verifyAppleNativeIdToken(await appleToken(), RAW_NONCE),
        ).resolves.toEqual({
            sub: '001234.abcdef.1234',
            email: 'shopper@privaterelay.appleid.com',
            emailVerified: true,
        })
    })

    it('hashes the nonce as lowercase hex SHA-256, like the app does', () => {
        expect(appleNonceHash('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        )
    })

    it.each([
        // The web flows' Services ID is not the app's audience.
        ['the Services ID audience', { aud: 'com.devino.caramel.signin' }],
        ['another issuer', { iss: 'https://evil.example' }],
        ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ])('refuses %s', async (_label, opts) => {
        await expect(
            verifyAppleNativeIdToken(await appleToken({}, opts), RAW_NONCE),
        ).resolves.toBeNull()
    })

    it('refuses a token minted for another nonce (replay)', async () => {
        const token = await appleToken({ nonce: appleNonceHash('other') })
        await expect(
            verifyAppleNativeIdToken(token, RAW_NONCE),
        ).resolves.toBeNull()
    })

    it('refuses a token with no nonce', async () => {
        const token = await appleToken({ nonce: undefined })
        await expect(
            verifyAppleNativeIdToken(token, RAW_NONCE),
        ).resolves.toBeNull()
    })

    it('refuses a token signed by a key Apple does not publish', async () => {
        const token = await appleToken({}, { key: otherPrivateKey })
        await expect(
            verifyAppleNativeIdToken(token, RAW_NONCE),
        ).resolves.toBeNull()
    })

    it('reads email_verified "false" as unverified', async () => {
        const claims = await verifyAppleNativeIdToken(
            await appleToken({ email_verified: 'false' }),
            RAW_NONCE,
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
                verifyAppleNativeIdToken(await appleToken(), RAW_NONCE),
            ).rejects.toThrow('fetch failed')
        } finally {
            keys.current = saved
        }
    })
})

describe('redeemAppleNativeCode', () => {
    it('redeems the code as the app client (bundle id, no redirect_uri)', async () => {
        await expect(redeemAppleNativeCode('one-time-code')).resolves.toEqual({
            accessToken: 'apple-access',
            refreshToken: 'apple-refresh',
        })
        const [url, init] = fetchMock.mock.calls[0]!
        expect(url).toBe('https://appleid.apple.com/auth/token')
        expect(
            Object.fromEntries(
                new URLSearchParams(init!.body as URLSearchParams),
            ),
        ).toEqual({
            client_id: BUNDLE_ID,
            client_secret: 'signed-client-secret',
            code: 'one-time-code',
            grant_type: 'authorization_code',
        })
    })

    it('Apple refuses: null, reported with Apple error code and never the code', async () => {
        fetchMock.mockResolvedValue(
            Response.json({ error: 'invalid_client' }, { status: 400 }),
        )
        await expect(redeemAppleNativeCode('one-time-code')).resolves.toBeNull()
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [error, hint] = captureExceptionMock.mock.calls[0]!
        expect((error as Error).message).toBe(
            'Apple native code redeem failed: apple_rejected',
        )
        expect(hint).toMatchObject({
            tags: { reason: 'apple_rejected' },
            extra: { status: 400, appleError: 'invalid_client' },
        })
        expect(JSON.stringify(captureExceptionMock.mock.calls)).not.toContain(
            'one-time-code',
        )
    })

    it('an answer without a refresh token is not a grant to keep', async () => {
        fetchMock.mockResolvedValue(Response.json({ access_token: 'a' }))
        await expect(redeemAppleNativeCode('one-time-code')).resolves.toBeNull()
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    })

    it('transport failure: null, reported with the cause', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'))
        await expect(redeemAppleNativeCode('one-time-code')).resolves.toBeNull()
        expect(captureExceptionMock.mock.calls[0]![1]).toMatchObject({
            tags: { reason: 'request_not_completed' },
            extra: { cause: 'fetch failed' },
        })
    })
})

describe('POST /api/extension/oauth/apple-id-token', () => {
    it('mints the session and keeps the redeemed grant with its id token', async () => {
        const idToken = await appleToken()
        const res = await post({
            idToken,
            nonce: RAW_NONCE,
            authorizationCode: 'one-time-code',
            name: 'Sam Shopper',
        })
        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            token: 'session-token',
            username: 'Apple User',
            image: null,
        })
        expect(mintExtensionSession).toHaveBeenCalledWith({
            provider: 'apple',
            providerUser: {
                id: '001234.abcdef.1234',
                email: 'shopper@privaterelay.appleid.com',
                name: 'Sam Shopper',
                image: null,
                emailVerified: true,
            },
            tokens: {
                accessToken: 'apple-access',
                refreshToken: 'apple-refresh',
                idToken,
            },
        })
    })

    it('still signs in when the code redeem fails, storing no new tokens', async () => {
        fetchMock.mockResolvedValue(
            Response.json({ error: 'invalid_grant' }, { status: 400 }),
        )
        const res = await post({
            idToken: await appleToken(),
            nonce: RAW_NONCE,
            authorizationCode: 'one-time-code',
        })
        expect(res.status).toBe(200)
        const minted = vi.mocked(mintExtensionSession).mock.calls[0]![0]
        expect(minted.providerUser.name).toBeNull()
        expect(minted.tokens).toEqual({})
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    })

    it('answers 401 and mints nothing for a token for another nonce', async () => {
        const res = await post({
            idToken: await appleToken(),
            nonce: 'some-other-raw-nonce-value',
        })
        expect(res.status).toBe(401)
        expect(mintExtensionSession).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('answers 403 for an unverified Apple email', async () => {
        const res = await post({
            idToken: await appleToken({ email_verified: 'false' }),
            nonce: RAW_NONCE,
        })
        expect(res.status).toBe(403)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 400 when a new account has no email to create it with', async () => {
        vi.mocked(mintExtensionSession).mockRejectedValueOnce(
            new ExtensionOAuthEmailRequiredError('apple'),
        )
        const res = await post({
            idToken: await appleToken({ email: undefined }),
            nonce: RAW_NONCE,
        })
        expect(res.status).toBe(400)
    })

    it('answers 422 for a body without a nonce', async () => {
        const res = await post({ idToken: await appleToken() })
        expect(res.status).toBe(422)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })

    it('answers 500 when Apple sign-in is not configured', async () => {
        envMock.APPLE_CLIENT_ID = undefined
        const res = await post({
            idToken: await appleToken(),
            nonce: RAW_NONCE,
        })
        expect(res.status).toBe(500)
        expect(mintExtensionSession).not.toHaveBeenCalled()
    })
})
