// tests/unit/web-session-handoff.test.ts — T-7852 acceptance checks 5–6
//
// Validates the next-path allowlist. The routes themselves (the shell-only
// redeem, the handoff body cap, 401 without a bearer) are tested in
// tests/unit/web-session-routes.test.ts.
// The full mint → redeem → working-cookie round trip on real Postgres is
// tests/integration/web-session-handoff.itest.ts (T-9213).
import { HandoffBody } from '@/lib/webSessionHandoff'
import { describe, expect, it } from 'vitest'

const valid = (s: string) => HandoffBody.safeParse({ next: s }).success
const invalid = (s: string) => !valid(s)

describe('T-7852 handoff next-path validation', () => {
    it('accepts "/" and allowed-prefix paths', () => {
        expect(valid('/')).toBe(true)
        expect(valid('/coupons')).toBe(true)
        expect(valid('/coupons/amazon.com')).toBe(true)
        expect(valid('/profile')).toBe(true)
        expect(valid('/profile#favorites')).toBe(true)
        expect(valid('/welcome?src=ext')).toBe(true)
    })

    // T-7852 acceptance check 5 — each of these must be rejected.
    it('rejects "//evil.com"', () => expect(invalid('//evil.com')).toBe(true))
    it('rejects "https://evil.com"', () =>
        expect(invalid('https://evil.com')).toBe(true))
    it('rejects "/\\\\evil.com"', () =>
        expect(invalid('/\\evil.com')).toBe(true))
    it('rejects "/coupons%0d%0aX" (header injection)', () =>
        expect(invalid('/coupons%0d%0aX')).toBe(true))
    it('rejects " /coupons" (leading space)', () =>
        expect(invalid(' /coupons')).toBe(true))
    it('rejects "/coupons\\t" (tab)', () =>
        expect(invalid('/coupons\t')).toBe(true))
    it('rejects "/api/auth/sign-out" (not in allowed prefixes)', () =>
        expect(invalid('/api/auth/sign-out')).toBe(true))
    it('rejects "/login" (not in allowed prefixes)', () =>
        expect(invalid('/login')).toBe(true))

    it('rejects paths that do not start with an allowed prefix', () => {
        expect(invalid('/settings')).toBe(true)
        expect(invalid('/admin')).toBe(true)
        expect(invalid('/api/anything')).toBe(true)
    })
})
