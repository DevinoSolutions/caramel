import {
    checkRateLimit,
    isExtensionOrigin,
    isTrustedServer,
} from '@/lib/rateLimit'
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

// isTrustedServer now compares in constant time (hash both sides to
// fixed-length digests, then timingSafeEqual). These pins characterize the
// functional contract that the timing-safe refactor must preserve exactly:
// the right secret still grants trust; a wrong secret (whether the same
// length OR a different length — the latter would make a naive timingSafeEqual
// throw) is rejected; and it stays fail-closed when the secret is unset or the
// header is absent.
describe('isTrustedServer (constant-time admin-secret compare)', () => {
    it('true for the exact Bearer $COUPONS_ADMIN_SECRET', () => {
        envMock.COUPONS_ADMIN_SECRET = ADMIN_SECRET
        expect(
            isTrustedServer(
                makeRequest('198.51.100.1', {
                    authorization: `Bearer ${ADMIN_SECRET}`,
                }),
            ),
        ).toBe(true)
    })

    it('false for a wrong secret of the SAME length (not merely a length check)', () => {
        envMock.COUPONS_ADMIN_SECRET = ADMIN_SECRET
        const sameLengthWrong = 'x'.repeat(ADMIN_SECRET.length)
        expect(sameLengthWrong.length).toBe(ADMIN_SECRET.length)
        expect(
            isTrustedServer(
                makeRequest('198.51.100.2', {
                    authorization: `Bearer ${sameLengthWrong}`,
                }),
            ),
        ).toBe(false)
    })

    it('false for a wrong secret of a DIFFERENT length (timingSafeEqual must not throw)', () => {
        envMock.COUPONS_ADMIN_SECRET = ADMIN_SECRET
        expect(
            isTrustedServer(
                makeRequest('198.51.100.3', { authorization: 'Bearer short' }),
            ),
        ).toBe(false)
    })

    it('false when COUPONS_ADMIN_SECRET is unset (fail-closed)', () => {
        envMock.COUPONS_ADMIN_SECRET = undefined
        expect(
            isTrustedServer(
                makeRequest('198.51.100.4', {
                    authorization: `Bearer ${ADMIN_SECRET}`,
                }),
            ),
        ).toBe(false)
    })

    it('false when no Authorization header is present', () => {
        envMock.COUPONS_ADMIN_SECRET = ADMIN_SECRET
        expect(isTrustedServer(makeRequest('198.51.100.5'))).toBe(false)
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

// M1 (review of PR #353): the extension's opt-in funnel diagnostics report one
// step per call and are low value, so they get their OWN bucket (60/min, keyed
// ip+route) that must neither spend the shared mutation / burst budget a
// shopper's code submission depends on, nor be starved by it.
describe('checkRateLimit: the isolated telemetry bucket', () => {
    const telemetryRequest = (ip: string, path = '/api/extension/telemetry') =>
        new NextRequest(`http://localhost${path}`, {
            method: 'POST',
            headers: { 'x-real-ip': ip },
        })

    it('allows 60 rapid calls (it is exempt from the 20-per-2s shared burst), then 429s with its own limit header', async () => {
        const ip = '203.0.113.20'

        for (let i = 0; i < 60; i++) {
            expect(
                await checkRateLimit(telemetryRequest(ip), 'telemetry'),
            ).toBeNull()
        }
        const blocked = await checkRateLimit(telemetryRequest(ip), 'telemetry')

        expect(blocked?.status).toBe(429)
        expect(blocked?.headers.get('X-RateLimit-Limit')).toBe('60')
        expect(blocked?.headers.get('Retry-After')).toBeTruthy()
    })

    it('an exhausted telemetry bucket leaves the same IP its full mutation and burst budget', async () => {
        const ip = '203.0.113.21'
        for (let i = 0; i < 61; i++)
            await checkRateLimit(telemetryRequest(ip), 'telemetry')

        // 20 is the shared burst allowance: had telemetry drawn on it, or on
        // the mutation bucket, a submission right after would be refused.
        for (let i = 0; i < 20; i++) {
            expect(
                await checkRateLimit(
                    makeRequest(ip, { origin: 'chrome-extension://abc' }),
                    'mutation',
                ),
            ).toBeNull()
        }
    })

    it('an exhausted mutation bucket does not starve telemetry', async () => {
        const ip = '203.0.113.22'
        let blocked: Awaited<ReturnType<typeof checkRateLimit>> = null
        for (let i = 0; i < 40 && !blocked; i++)
            blocked = await checkRateLimit(makeRequest(ip), 'mutation')
        expect(blocked?.status).toBe(429)

        expect(
            await checkRateLimit(telemetryRequest(ip), 'telemetry'),
        ).toBeNull()
    })

    it('is keyed ip + route: another IP, and another route on the same IP, have their own 60', async () => {
        const ip = '203.0.113.23'
        for (let i = 0; i < 61; i++)
            await checkRateLimit(telemetryRequest(ip), 'telemetry')

        expect(
            await checkRateLimit(telemetryRequest('203.0.113.24'), 'telemetry'),
        ).toBeNull()
        expect(
            await checkRateLimit(
                telemetryRequest(ip, '/api/other/telemetry'),
                'telemetry',
            ),
        ).toBeNull()
        expect(
            (await checkRateLimit(telemetryRequest(ip), 'telemetry'))?.status,
        ).toBe(429)
    })
})
