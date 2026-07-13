import {
    base64Decode,
    base64Encode,
    decrypt,
    encrypt,
    encryptJsonServer,
} from '@/lib/securityHelpers/cryptoHelpers'
import { NextApiRequest } from 'next'
import { describe, expect, it } from 'vitest'

// Characterization pins (F-013) — lock CURRENT behavior of cryptoHelpers.ts
// before encryptJsonServer's `payload` param widens `any`->`unknown` and
// decryptJsonClient's return narrows `any`->`unknown`. decryptJsonClient
// itself needs `window`/`navigator` (browser-only) — per plan, pinned here
// via its pure ingredients (encrypt/decrypt, which decryptJsonClient calls
// through unchanged) rather than adding a jsdom environment for this file.
// The decryptJsonClient<-decryptJsonData seam is already pinned end-to-end
// (with cryptoHelpers mocked) by decryptJsonData.test.ts.

function makeApiReq(host: string, userAgent: string): NextApiRequest {
    return {
        headers: { host, 'user-agent': userAgent },
    } as unknown as NextApiRequest
}

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

describe('encryptJsonServer', () => {
    it('strips the port from Host and combines with User-Agent as the XOR key — pins behavior across the payload any->unknown widen', () => {
        const req = makeApiReq('example.com:3000', 'test-agent')
        const payload = { hello: 'world', n: 42 }

        const cipher = encryptJsonServer(req, payload)

        // Independently decrypt with the pure primitive using the same
        // port-stripped-domain + UA key derivation encryptJsonServer uses.
        const decrypted = decrypt(cipher, 'example.comtest-agent')
        expect(JSON.parse(decrypted)).toEqual(payload)
    })

    it('missing Host/User-Agent headers fall back to empty string (no throw)', () => {
        const req = { headers: {} } as unknown as NextApiRequest
        expect(() => encryptJsonServer(req, { a: 1 })).not.toThrow()
    })
})
