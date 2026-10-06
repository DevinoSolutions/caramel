import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'

import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// Runtime Apple client-secret signing (2026-10-03). The static pre-signed JWT
// in Dokploy env expired 2026-09-27 and broke Apple sign-in on prod + dev; the
// app now signs its own ES256 secret from the .p8 key. The key below is a
// THROWAWAY P-256 pair generated in-test — never a real Apple key.
//
// The helper is deliberately SYNCHRONOUS (node:crypto): better-auth resolves
// the Apple config object once and later reads `options.clientSecret` off it at
// token-exchange time, so the secret has to be readable through a plain getter.

const envMock = vi.hoisted(() => ({
    APPLE_CLIENT_ID: 'com.test.signin' as string | undefined,
    APPLE_TEAM_ID: 'TEAM123456' as string | undefined,
    APPLE_KEY_ID: 'KEYID12345' as string | undefined,
    APPLE_PRIVATE_KEY: undefined as string | undefined,
}))

vi.mock('@/lib/env', () => ({ env: envMock }))

const DAY_SECONDS = 86_400
const APPLE_MAX_SECRET_LIFETIME_SECONDS = 15_777_000
const START = new Date('2026-10-03T12:00:00Z')

let publicKey: KeyObject
let pkcs8Pem: string

beforeAll(() => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    publicKey = pair.publicKey
    pkcs8Pem = pair.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString()
})

/** Load a FRESH module instance so each test starts with an empty token cache. */
async function loadHelper(): Promise<
    typeof import('@/lib/auth/appleClientSecret')
> {
    vi.resetModules()
    return import('@/lib/auth/appleClientSecret')
}

interface DecodedSecret {
    header: Record<string, unknown>
    payload: Record<string, unknown>
    signatureValid: boolean
}

/** Decode a compact JWT and verify its raw r||s ES256 signature. */
function decodeAndVerify(token: string): DecodedSecret {
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
        string,
        string,
        string,
    ]
    const decode = (part: string): Record<string, unknown> =>
        JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
            string,
            unknown
        >
    const signature = Buffer.from(encodedSignature, 'base64url')
    // ES256 over JWS is the fixed-width r||s form: 32 + 32 bytes.
    expect(signature).toHaveLength(64)
    return {
        header: decode(encodedHeader),
        payload: decode(encodedPayload),
        signatureValid: verify(
            'sha256',
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            signature,
        ),
    }
}

describe('getAppleClientSecret', () => {
    beforeEach(() => {
        envMock.APPLE_CLIENT_ID = 'com.test.signin'
        envMock.APPLE_TEAM_ID = 'TEAM123456'
        envMock.APPLE_KEY_ID = 'KEYID12345'
        // Dokploy's env writer stores the PEM on ONE line with literal \n.
        envMock.APPLE_PRIVATE_KEY = pkcs8Pem.trim().replace(/\r?\n/g, '\\n')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(START)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('signs an ES256 JWT Apple will accept: kid/alg header, iss/sub/aud, 180-day exp, valid signature', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const { header, payload, signatureValid } = decodeAndVerify(
            getAppleClientSecret(),
        )

        expect(signatureValid).toBe(true)
        expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' })
        expect(payload.iss).toBe('TEAM123456')
        expect(payload.sub).toBe('com.test.signin')
        expect(payload.aud).toBe('https://appleid.apple.com')
        const iat = payload.iat as number
        const exp = payload.exp as number
        expect(iat).toBe(Math.floor(START.getTime() / 1000))
        expect(exp - iat).toBe(180 * DAY_SECONDS)
        expect(exp - iat).toBeLessThanOrEqual(APPLE_MAX_SECRET_LIFETIME_SECONDS)
    })

    it('also accepts a real multi-line PEM value', async () => {
        envMock.APPLE_PRIVATE_KEY = pkcs8Pem
        const { getAppleClientSecret } = await loadHelper()
        expect(decodeAndVerify(getAppleClientSecret()).signatureValid).toBe(
            true,
        )
    })

    it('reuses the cached token while more than 30 days of validity remain', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const first = getAppleClientSecret()

        // 100 days later: 80 days left — still well inside the window.
        vi.setSystemTime(new Date(START.getTime() + 100 * DAY_SECONDS * 1000))

        expect(getAppleClientSecret()).toBe(first)
    })

    it('re-signs once fewer than 30 days remain, so a long-lived container never serves an expired secret', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const first = getAppleClientSecret()

        // 151 days later: 29 days left — below the 30-day re-sign threshold.
        const later = new Date(START.getTime() + 151 * DAY_SECONDS * 1000)
        vi.setSystemTime(later)
        const second = getAppleClientSecret()

        expect(second).not.toBe(first)
        const { payload, signatureValid } = decodeAndVerify(second)
        expect(signatureValid).toBe(true)
        expect(payload.iat).toBe(Math.floor(later.getTime() / 1000))
        expect(payload.exp).toBe((payload.iat as number) + 180 * DAY_SECONDS)
    })

    it('throws a loud, key-free error on a malformed private key', async () => {
        const garbage =
            '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----'
        envMock.APPLE_PRIVATE_KEY = garbage
        const { getAppleClientSecret } = await loadHelper()

        expect(() => getAppleClientSecret()).toThrow(/APPLE_PRIVATE_KEY/)
        try {
            getAppleClientSecret()
        } catch (error) {
            const message = (error as Error).message
            expect(message).not.toContain('not-a-real-key')
        }
    })

    it('rejects a valid PEM that is not a P-256 EC key (Apple requires ES256) without echoing it', async () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const rsaPem = rsa.privateKey
            .export({ format: 'pem', type: 'pkcs8' })
            .toString()
        envMock.APPLE_PRIVATE_KEY = rsaPem
        const { getAppleClientSecret } = await loadHelper()

        expect(() => getAppleClientSecret()).toThrow(/P-256/)
        try {
            getAppleClientSecret()
        } catch (error) {
            const body = rsaPem.split('\n')[1] ?? ''
            expect(body.length).toBeGreaterThan(20)
            expect((error as Error).message).not.toContain(body)
        }
    })

    it('does not cache a failed sign: fixing the key makes the next call succeed', async () => {
        const goodKey = envMock.APPLE_PRIVATE_KEY
        envMock.APPLE_PRIVATE_KEY =
            '-----BEGIN PRIVATE KEY-----\\nbroken\\n-----END PRIVATE KEY-----'
        const { getAppleClientSecret } = await loadHelper()
        expect(() => getAppleClientSecret()).toThrow(/APPLE_PRIVATE_KEY/)

        envMock.APPLE_PRIVATE_KEY = goodKey
        expect(decodeAndVerify(getAppleClientSecret()).signatureValid).toBe(
            true,
        )
    })

    it('throws naming every missing Apple signing variable', async () => {
        envMock.APPLE_KEY_ID = undefined
        envMock.APPLE_TEAM_ID = undefined
        const { getAppleClientSecret } = await loadHelper()

        expect(() => getAppleClientSecret()).toThrow(
            /APPLE_TEAM_ID.*APPLE_KEY_ID|APPLE_KEY_ID.*APPLE_TEAM_ID/,
        )
    })

    it('throws when Apple is not configured at all (APPLE_CLIENT_ID unset)', async () => {
        envMock.APPLE_CLIENT_ID = undefined
        const { getAppleClientSecret } = await loadHelper()

        expect(() => getAppleClientSecret()).toThrow(/APPLE_CLIENT_ID/)
    })
})

describe('createAppleSocialProviderConfig', () => {
    beforeEach(() => {
        envMock.APPLE_CLIENT_ID = 'com.test.signin'
        envMock.APPLE_TEAM_ID = 'TEAM123456'
        envMock.APPLE_KEY_ID = 'KEYID12345'
        envMock.APPLE_PRIVATE_KEY = pkcs8Pem.trim().replace(/\r?\n/g, '\\n')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(START)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    // THE property better-auth relies on. createAuthContext resolves the Apple
    // config ONCE and hands that very object to the Apple provider, whose token
    // exchange reads `options.clientSecret` per call (verified against
    // better-auth@1.6.23: create-context.mjs:98-102, apple.mjs, and
    // validate-authorization-code.mjs:40,44). So the secret must be fresh at
    // READ time, not at resolve time.
    it('yields a fresh secret when clientSecret is read off the SAME resolved object after time passes', async () => {
        const { createAppleSocialProviderConfig } = await loadHelper()
        const resolved = createAppleSocialProviderConfig({
            redirectURI: 'https://example.test/api/auth/callback/apple',
        })

        const atBoot = resolved.clientSecret
        expect(decodeAndVerify(atBoot).signatureValid).toBe(true)

        // The process lives 170 days without a restart: the boot secret is
        // 10 days from expiry. Same object, read again.
        const later = new Date(START.getTime() + 170 * DAY_SECONDS * 1000)
        vi.setSystemTime(later)
        const afterAgeing = resolved.clientSecret

        expect(afterAgeing).not.toBe(atBoot)
        const { payload } = decodeAndVerify(afterAgeing)
        const nowSeconds = Math.floor(later.getTime() / 1000)
        expect(payload.iat).toBe(nowSeconds)
        expect((payload.exp as number) - nowSeconds).toBe(180 * DAY_SECONDS)
    })

    it('survives the object being read by property access only (no spread, no clone)', async () => {
        const { createAppleSocialProviderConfig } = await loadHelper()
        const resolved = createAppleSocialProviderConfig({
            redirectURI: 'https://example.test/api/auth/callback/apple',
        })
        expect(resolved.clientId).toBe('com.test.signin')
        expect(resolved.redirectURI).toBe(
            'https://example.test/api/auth/callback/apple',
        )
        expect(
            Object.getOwnPropertyDescriptor(resolved, 'clientSecret')?.get,
        ).toBeTypeOf('function')
    })

    it('exposes an empty (falsy) secret when Apple is disabled, so better-auth refuses to start a sign-in', async () => {
        envMock.APPLE_CLIENT_ID = undefined
        const { createAppleSocialProviderConfig } = await loadHelper()
        const resolved = createAppleSocialProviderConfig({
            redirectURI: 'https://example.test/api/auth/callback/apple',
        })
        expect(resolved.clientSecret).toBe('')
    })
})

describe('createAppleSocialProviderConfig through the REAL better-auth Apple provider', () => {
    beforeEach(() => {
        envMock.APPLE_CLIENT_ID = 'com.test.signin'
        envMock.APPLE_TEAM_ID = 'TEAM123456'
        envMock.APPLE_KEY_ID = 'KEYID12345'
        envMock.APPLE_PRIVATE_KEY = pkcs8Pem.trim().replace(/\r?\n/g, '\\n')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(START)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    // Same wiring createAuthContext performs (create-context.mjs:102): build the
    // provider ONCE from the resolved config, then exchange codes much later.
    // The token endpoint is stubbed; what Apple would receive is asserted.
    it('sends Apple a fresh client_secret on a token exchange made long after the provider was built', async () => {
        const { apple } = await import('better-auth/social-providers')
        const { createAppleSocialProviderConfig } = await loadHelper()

        const sentSecrets: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
                sentSecrets.push(
                    new URLSearchParams(String(init?.body)).get(
                        'client_secret',
                    ) ?? '',
                )
                return new Response(
                    JSON.stringify({
                        access_token: 'stub-access-token',
                        token_type: 'Bearer',
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    },
                )
            }),
        )

        const provider = apple(
            createAppleSocialProviderConfig({
                redirectURI: 'https://example.test/api/auth/callback/apple',
            }),
        )
        const exchange = (): Promise<unknown> =>
            provider.validateAuthorizationCode({
                code: 'stub-code',
                redirectURI: 'https://example.test/api/auth/callback/apple',
            })

        await exchange()
        // 170 days later the provider object is still the one built at "boot".
        const later = new Date(START.getTime() + 170 * DAY_SECONDS * 1000)
        vi.setSystemTime(later)
        await exchange()

        expect(sentSecrets).toHaveLength(2)
        const [atBoot, afterAgeing] = sentSecrets as [string, string]
        expect(decodeAndVerify(atBoot).signatureValid).toBe(true)
        expect(afterAgeing).not.toBe(atBoot)
        const aged = decodeAndVerify(afterAgeing)
        expect(aged.signatureValid).toBe(true)
        expect(aged.payload.iat).toBe(Math.floor(later.getTime() / 1000))
    })
})
