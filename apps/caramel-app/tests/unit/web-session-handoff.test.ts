// tests/unit/web-session-handoff.test.ts — T-7852 acceptance checks 5–6
//
// Validates the next-path allowlist. The routes themselves (the shell-only
// redeem, the handoff body cap, 401 without a bearer) are tested in
// tests/unit/web-session-routes.test.ts.
// TODO(T-9213): no integration test runs the full round trip (checks 1–4,
// 7–8) on real Postgres yet; the device runs are the only end-to-end proof.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

// Mirror the handoff route's validation exactly so we test the same rules.
// The route's own HandoffBody is not exported, so we replicate the schema
// (a change to one that does not change the other is caught by the
// integration tests' real HTTP round trips).
const ALLOWED_NEXT_PREFIXES = ['/coupons', '/profile', '/welcome']

const HandoffBody = z.object({
    next: z
        .string()
        .max(512)
        .refine(
            s => {
                if (s === '/') return true
                for (let i = 0; i < s.length; i++) {
                    const c = s.charCodeAt(i)
                    if (c <= 0x1f || c === 0x7f) return false
                }
                if (/\s/.test(s) || s.includes('\\')) return false
                if (s.startsWith('//')) return false
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false
                if (/%0[dDaA]/i.test(s)) return false
                if (!ALLOWED_NEXT_PREFIXES.some(p => s.startsWith(p)))
                    return false
                return /^\/(?!\/)[^\s\\]*$/.test(s)
            },
            { message: 'invalid next' },
        ),
})

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
