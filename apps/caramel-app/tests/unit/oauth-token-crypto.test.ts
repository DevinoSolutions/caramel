import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Encryption at rest for accounts.access_token / refresh_token (T-5065). The
// format must be exactly better-auth's own `encryptOAuthTokens` format, because
// better-auth's web callback and the extension/app mint both write the same
// column and ONE reader (the Apple revoke at account deletion) handles both.

const envMock = vi.hoisted(() => ({
    BETTER_AUTH_SECRET: 'test-auth-secret' as string | undefined,
    JWT_SECRET: undefined as string | undefined,
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

import {
    decryptOAuthToken,
    encryptOAuthToken,
} from '@/lib/auth/oauthTokenCrypto'

const APPLE_REFRESH_TOKEN = 'r.0a1b2c3d4e5f.0.nQxyz-refresh'

beforeEach(() => {
    envMock.BETTER_AUTH_SECRET = 'test-auth-secret'
    envMock.JWT_SECRET = undefined
})

describe('oauthTokenCrypto', () => {
    it('stores ciphertext that is not the token, and round-trips it', async () => {
        const stored = await encryptOAuthToken(APPLE_REFRESH_TOKEN)

        expect(stored).not.toBeNull()
        expect(stored).not.toContain(APPLE_REFRESH_TOKEN)
        expect(await decryptOAuthToken(stored as string)).toBe(
            APPLE_REFRESH_TOKEN,
        )
    })

    it("is better-auth's own format: its symmetricDecrypt reads ours and ours reads its", async () => {
        const ours = await encryptOAuthToken(APPLE_REFRESH_TOKEN)
        expect(
            await symmetricDecrypt({
                key: 'test-auth-secret',
                data: ours as string,
            }),
        ).toBe(APPLE_REFRESH_TOKEN)

        const theirs = await symmetricEncrypt({
            key: 'test-auth-secret',
            data: APPLE_REFRESH_TOKEN,
        })
        expect(await decryptOAuthToken(theirs)).toBe(APPLE_REFRESH_TOKEN)
    })

    it('passes a token stored before encryption was enabled (plain text) through unchanged', async () => {
        expect(await decryptOAuthToken(APPLE_REFRESH_TOKEN)).toBe(
            APPLE_REFRESH_TOKEN,
        )
        expect(await decryptOAuthToken('a1b2c3.opaque.access')).toBe(
            'a1b2c3.opaque.access',
        )
    })

    it('encrypts nothing for an absent or empty token', async () => {
        expect(await encryptOAuthToken(undefined)).toBeNull()
        expect(await encryptOAuthToken(null)).toBeNull()
        expect(await encryptOAuthToken('')).toBeNull()
    })

    it('throws (never returns ciphertext) when the key no longer matches', async () => {
        const stored = (await encryptOAuthToken(APPLE_REFRESH_TOKEN)) as string
        envMock.BETTER_AUTH_SECRET = 'rotated-secret'

        await expect(decryptOAuthToken(stored)).rejects.toThrow()
    })

    it('falls back to JWT_SECRET exactly as auth.ts does, and throws with neither', async () => {
        envMock.BETTER_AUTH_SECRET = undefined
        envMock.JWT_SECRET = 'jwt-only-secret'
        const stored = (await encryptOAuthToken(APPLE_REFRESH_TOKEN)) as string
        expect(
            await symmetricDecrypt({ key: 'jwt-only-secret', data: stored }),
        ).toBe(APPLE_REFRESH_TOKEN)

        envMock.JWT_SECRET = undefined
        await expect(encryptOAuthToken(APPLE_REFRESH_TOKEN)).rejects.toThrow(
            /BETTER_AUTH_SECRET nor JWT_SECRET/,
        )
    })
})
