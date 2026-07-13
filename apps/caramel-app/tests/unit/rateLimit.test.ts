import { checkRateLimit, isExtensionOrigin } from '@/lib/rateLimit'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Characterization pins (F-004), flipped by F-003 — the public extension-key
// exemption is retired; a server-only COUPONS_ADMIN_SECRET bearer takes its
// place. Pins (a)/(b) now prove the OLD key-shaped headers grant NOTHING
// (the point of F-003: the shipped key stops conferring any privilege the
// instant it's deployed). Pin (c) is unchanged. Pin (d) is new: the bearer
// secret is what grants the exemption now.
//
// Each pin uses a unique x-real-ip: the burst (20/2s) and per-minute
// limiters are module-level singletons shared by every test in this file,
// so reusing an IP across tests would leak budget between them.
const STALE_EXTENSION_KEY = 'test-extension-key-F004'
const ADMIN_SECRET = 'test-admin-secret-F003'

const { envMock } = vi.hoisted(() => ({
    envMock: { COUPONS_ADMIN_SECRET: undefined as string | undefined },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

function makeRequest(ip: string, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/coupons', {
        headers: { 'x-real-ip': ip, ...headers },
    })
}

beforeEach(() => {
    envMock.COUPONS_ADMIN_SECRET = ADMIN_SECRET
})

describe('checkRateLimit', () => {
    it('(a) stale x-api-key (the old, now-retired extension key header) no longer exempts — rides burst past 20 calls/2s -> 429', async () => {
        const ip = '203.0.113.10'

        let blocked: Awaited<ReturnType<typeof checkRateLimit>> = null
        for (let i = 0; i < 25; i++) {
            const result = await checkRateLimit(
                makeRequest(ip, { 'x-api-key': STALE_EXTENSION_KEY }),
                'read',
            )
            if (result) {
                blocked = result
                break
            }
        }

        expect(blocked).not.toBeNull()
        expect(blocked?.status).toBe(429)
    })

    it('(b) stale x-extension-api-key (back-compat header) no longer exempts either — rides burst past 20 calls/2s -> 429', async () => {
        const ip = '203.0.113.11'

        let blocked: Awaited<ReturnType<typeof checkRateLimit>> = null
        for (let i = 0; i < 25; i++) {
            const result = await checkRateLimit(
                makeRequest(ip, { 'x-extension-api-key': STALE_EXTENSION_KEY }),
                'read',
            )
            if (result) {
                blocked = result
                break
            }
        }

        expect(blocked).not.toBeNull()
        expect(blocked?.status).toBe(429)
    })

    it('(c) no key, same IP: bursting past 20 calls/2s returns a 429 NextResponse', async () => {
        const ip = '203.0.113.12'

        let blocked: Awaited<ReturnType<typeof checkRateLimit>> = null
        for (let i = 0; i < 25; i++) {
            const result = await checkRateLimit(makeRequest(ip), 'read')
            if (result) {
                blocked = result
                break
            }
        }

        expect(blocked).not.toBeNull()
        expect(blocked?.status).toBe(429)
        const body = await blocked?.json()
        expect(body.error).toBe('Too many requests. Please slow down.')
    })

    it('(d) Authorization: Bearer $COUPONS_ADMIN_SECRET stays null across 25 rapid calls (server-identity exemption)', async () => {
        const ip = '203.0.113.13'

        for (let i = 0; i < 25; i++) {
            const result = await checkRateLimit(
                makeRequest(ip, { authorization: `Bearer ${ADMIN_SECRET}` }),
                'read',
            )
            expect(result).toBeNull()
        }
    })
})

// D5 (E2E report) — isOriginAllowed()'s `if (!origin) return true` bypass is
// deliberate for routes that legitimately accept server-to-server/curl
// calls (comment above it says so), but classify-cart is a paid LLM-backed
// endpoint that should ONLY ever be reachable from the extension — a
// missing Origin let it through as a 200. isExtensionOrigin() is the
// stricter, purpose-built check for that route: present AND an actual
// browser-extension protocol, no missing-Origin bypass, no same-origin/
// ALLOWED_ORIGINS exemption (those don't apply to "must be the extension").
describe('isExtensionOrigin', () => {
    function makeOriginRequest(origin?: string) {
        return new NextRequest('http://localhost/api/classify-cart', {
            method: 'POST',
            headers: origin ? { origin } : {},
        })
    }

    it('true for a chrome-extension:// Origin — ANY extension id, no allowlist match required', () => {
        expect(
            isExtensionOrigin(
                makeOriginRequest('chrome-extension://some-random-id'),
            ),
        ).toBe(true)
    })

    it('true for moz-extension:// and safari-web-extension:// Origins too', () => {
        expect(
            isExtensionOrigin(makeOriginRequest('moz-extension://abc')),
        ).toBe(true)
        expect(
            isExtensionOrigin(makeOriginRequest('safari-web-extension://abc')),
        ).toBe(true)
    })

    it('false when the Origin header is absent — the exact D5 hole isOriginAllowed leaves open', () => {
        expect(isExtensionOrigin(makeOriginRequest())).toBe(false)
    })

    it('false for a same-origin or arbitrary website Origin (not just "any non-empty origin")', () => {
        expect(isExtensionOrigin(makeOriginRequest('http://localhost'))).toBe(
            false,
        )
        expect(
            isExtensionOrigin(makeOriginRequest('https://evil.example.com')),
        ).toBe(false)
    })

    it('false for a malformed Origin header (caught, not thrown)', () => {
        expect(isExtensionOrigin(makeOriginRequest('not-a-url'))).toBe(false)
    })
})
