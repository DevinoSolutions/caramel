import {
    base64Decode,
    base64Encode,
    decrypt,
    encrypt,
} from '@/lib/securityHelpers/cryptoHelpers'
import { describe, expect, it } from 'vitest'

// Characterization pins (F-013) — lock CURRENT behavior of cryptoHelpers.ts
// before decryptJsonClient's return narrows `any`->`unknown`. decryptJsonClient
// itself needs `window`/`navigator` (browser-only) — per plan, pinned here
// via its pure ingredients (encrypt/decrypt, which decryptJsonClient calls
// through unchanged) rather than adding a jsdom environment for this file.
// The decryptJsonClient<-decryptJsonData seam is already pinned end-to-end
// (with cryptoHelpers mocked) by decryptJsonData.test.ts.

describe('base64Encode / base64Decode', () => {
    it('round-trips arbitrary text', () => {
        // btoa (base64Encode's implementation) only accepts Latin1 — no
        // multi-byte characters; that constraint predates this finding and
        // is out of scope, so the pin stays within it.
        const text = 'hello, caramel! 123 !@#$%^&*()'
        expect(base64Decode(base64Encode(text))).toBe(text)
    })
})

describe('encrypt / decrypt (pure XOR+base64)', () => {
    it('decrypt(encrypt(x, k), k) === x', () => {
        const text = 'the quick brown fox jumps over the lazy dog'
        const key = 'some-domain.comMozilla/5.0 test-agent'
        expect(decrypt(encrypt(text, key), key)).toBe(text)
    })

    it('JSON round-trips through stringify -> encrypt -> decrypt -> parse — pins the parse behavior decryptJsonClient relies on across its any->unknown return narrow', () => {
        const key = 'example.comtest-UA'
        const payload = { status: 'success', data: { n: 1, list: [1, 2, 3] } }
        const cipher = encrypt(JSON.stringify(payload), key)
        const parsed = JSON.parse(decrypt(cipher, key))
        expect(parsed).toEqual(payload)
    })

    it('wrong key fails to reproduce the original text (sanity: the pin is not vacuous)', () => {
        const text = 'secret payload'
        const cipher = encrypt(text, 'right-key')
        expect(decrypt(cipher, 'wrong-key')).not.toBe(text)
    })
})
