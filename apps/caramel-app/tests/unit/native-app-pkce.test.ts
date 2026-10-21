import {
    codeVerifierMatchesChallenge,
    isValidCodeChallenge,
    isValidCodeVerifier,
} from '@/lib/auth/nativeAppPkce'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

// The RFC 7636 appendix B vector: the one published S256 pair, so the helper is
// pinned to the spec and not only to its own round trip.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('nativeAppPkce', () => {
    it('matches the RFC 7636 appendix B pair', () => {
        expect(codeVerifierMatchesChallenge(RFC_VERIFIER, RFC_CHALLENGE)).toBe(
            true,
        )
    })

    it('matches a pair derived the way the app derives it', () => {
        const verifier = 'x'.repeat(43)
        const challenge = createHash('sha256')
            .update(verifier)
            .digest('base64url')
        expect(codeVerifierMatchesChallenge(verifier, challenge)).toBe(true)
    })

    it('refuses a different verifier, and a challenge used as a verifier', () => {
        expect(
            codeVerifierMatchesChallenge('y'.repeat(43), RFC_CHALLENGE),
        ).toBe(false)
        expect(codeVerifierMatchesChallenge(RFC_CHALLENGE, RFC_CHALLENGE)).toBe(
            false,
        )
    })

    it('enforces the RFC length and alphabet bounds', () => {
        expect(isValidCodeVerifier('a'.repeat(42))).toBe(false)
        expect(isValidCodeVerifier('a'.repeat(43))).toBe(true)
        expect(isValidCodeVerifier('a'.repeat(128))).toBe(true)
        expect(isValidCodeVerifier('a'.repeat(129))).toBe(false)
        expect(isValidCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false)
        expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true)
        expect(isValidCodeChallenge(`${RFC_CHALLENGE}=`)).toBe(false)
        expect(isValidCodeChallenge('a'.repeat(42))).toBe(false)
    })
})
