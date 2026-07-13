import { decryptJsonClient } from '@/lib/securityHelpers/cryptoHelpers'
import {
    DecryptError,
    decryptJsonData,
} from '@/lib/securityHelpers/decryptJsonData'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Characterization pins (F-004) — lock CURRENT behavior of decryptJsonData
// (src/lib/securityHelpers/decryptJsonData.ts), warts included.
// F-002 flips pin (c): a decrypt failure now THROWS instead of silently
// handing back the still-encrypted payload — callers can no longer mistake
// ciphertext for plaintext.
vi.mock('@/lib/securityHelpers/cryptoHelpers')

beforeEach(() => {
    vi.unstubAllEnvs()
    vi.mocked(decryptJsonClient).mockReset()
})

describe('decryptJsonData', () => {
    it('(a) encryption disabled: returns pageData || response || raw, unwrapped', () => {
        vi.stubEnv('NEXT_PUBLIC_API_ENCRYPTION_ENABLED', 'false')

        expect(decryptJsonData({ pageData: 'PAGE', response: 'RESP' })).toBe(
            'PAGE',
        )
        expect(decryptJsonData({ response: 'RESP' })).toBe('RESP')

        const raw = { other: 'x' }
        expect(decryptJsonData(raw)).toBe(raw)
        expect(decryptJsonClient).not.toHaveBeenCalled()
    })

    it('(b) encryption enabled, neither pageData nor response present: returns raw untouched', () => {
        vi.stubEnv('NEXT_PUBLIC_API_ENCRYPTION_ENABLED', 'true')

        const raw = { foo: 'bar' }
        expect(decryptJsonData(raw)).toBe(raw)
        expect(decryptJsonClient).not.toHaveBeenCalled()
    })

    it('(c) encryption enabled + decryptJsonClient throws -> throws DecryptError instead of returning ciphertext as if it were plaintext', () => {
        vi.stubEnv('NEXT_PUBLIC_API_ENCRYPTION_ENABLED', 'true')
        const cause = new Error('bad ciphertext')
        vi.mocked(decryptJsonClient).mockImplementation(() => {
            throw cause
        })

        const raw = { response: 'STILL-ENCRYPTED-BLOB' }
        let thrown: unknown
        try {
            decryptJsonData(raw)
        } catch (e) {
            thrown = e
        }
        expect(thrown).toBeInstanceOf(DecryptError)
        expect((thrown as DecryptError).cause).toBe(cause)
        expect(decryptJsonClient).toHaveBeenCalledWith('STILL-ENCRYPTED-BLOB')
    })
})
