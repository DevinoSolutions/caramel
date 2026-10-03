import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from 'jose'
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

let publicKey: CryptoKey
let pkcs8Pem: string

beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    publicKey = pair.publicKey
    pkcs8Pem = await exportPKCS8(pair.privateKey)
})

/** Load a FRESH module instance so each test starts with an empty token cache. */
async function loadHelper(): Promise<
    typeof import('@/lib/auth/appleClientSecret')
> {
    vi.resetModules()
    return import('@/lib/auth/appleClientSecret')
}

async function verify(token: string) {
    return jwtVerify(token, publicKey, {
        algorithms: ['ES256'],
        issuer: 'TEAM123456',
        subject: 'com.test.signin',
        audience: 'https://appleid.apple.com',
    })
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

    it('signs an ES256 JWT Apple will accept: kid/alg header, iss/sub/aud, 180-day exp', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const token = await getAppleClientSecret()

        const { payload, protectedHeader } = await verify(token)
        expect(protectedHeader.alg).toBe('ES256')
        expect(protectedHeader.kid).toBe('KEYID12345')
        expect(payload.iss).toBe('TEAM123456')
        expect(payload.sub).toBe('com.test.signin')
        expect(payload.aud).toBe('https://appleid.apple.com')
        expect(payload.iat).toBe(Math.floor(START.getTime() / 1000))
        expect(payload.exp! - payload.iat!).toBe(180 * DAY_SECONDS)
        expect(payload.exp! - payload.iat!).toBeLessThan(
            APPLE_MAX_SECRET_LIFETIME_SECONDS,
        )
    })

    it('also accepts a real multi-line PEM value', async () => {
        envMock.APPLE_PRIVATE_KEY = pkcs8Pem
        const { getAppleClientSecret } = await loadHelper()
        await expect(verify(await getAppleClientSecret())).resolves.toBeTruthy()
    })

    it('reuses the cached token while more than 30 days of validity remain', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const first = await getAppleClientSecret()

        // 100 days later: 80 days left — still well inside the window.
        vi.setSystemTime(new Date(START.getTime() + 100 * DAY_SECONDS * 1000))
        const second = await getAppleClientSecret()

        expect(second).toBe(first)
    })

    it('re-signs once fewer than 30 days remain, so a long-lived container never serves an expired secret', async () => {
        const { getAppleClientSecret } = await loadHelper()
        const first = await getAppleClientSecret()

        // 151 days later: 29 days left — below the 30-day re-sign threshold.
        const later = new Date(START.getTime() + 151 * DAY_SECONDS * 1000)
        vi.setSystemTime(later)
        const second = await getAppleClientSecret()

        expect(second).not.toBe(first)
        const { payload } = await verify(second)
        expect(payload.iat).toBe(Math.floor(later.getTime() / 1000))
        expect(payload.exp).toBe(payload.iat! + 180 * DAY_SECONDS)
    })

    it('throws a loud, key-free error on a malformed private key', async () => {
        const garbage =
            '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----'
        envMock.APPLE_PRIVATE_KEY = garbage
        const { getAppleClientSecret } = await loadHelper()

        const failure = await getAppleClientSecret().then(
            () => undefined,
            (error: unknown) => error,
        )

        expect(failure).toBeInstanceOf(Error)
        const message = (failure as Error).message
        expect(message).toMatch(/APPLE_PRIVATE_KEY/)
        expect(message).not.toContain('not-a-real-key')
    })

    it('throws naming every missing Apple signing variable', async () => {
        envMock.APPLE_KEY_ID = undefined
        envMock.APPLE_TEAM_ID = undefined
        const { getAppleClientSecret } = await loadHelper()

        await expect(getAppleClientSecret()).rejects.toThrow(
            /APPLE_TEAM_ID.*APPLE_KEY_ID|APPLE_KEY_ID.*APPLE_TEAM_ID/,
        )
    })

    it('throws when Apple is not configured at all (APPLE_CLIENT_ID unset)', async () => {
        envMock.APPLE_CLIENT_ID = undefined
        const { getAppleClientSecret } = await loadHelper()

        await expect(getAppleClientSecret()).rejects.toThrow(/APPLE_CLIENT_ID/)
    })
})
