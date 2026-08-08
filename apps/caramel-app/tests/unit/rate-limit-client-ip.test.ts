import type { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import { getClientIp } from '@/lib/rateLimit'

function reqWith(headers: Record<string, string>): NextRequest {
    return {
        headers: new Headers(headers),
        url: 'https://grabcaramel.com/api/coupons',
    } as unknown as NextRequest
}

/**
 * These pin the ORDER, not just the parsing. The production defect was purely
 * an ordering one: X-Real-IP was consulted first, and behind Cloudflare that
 * header carries the Traefik peer (the Cloudflare edge), identical for every
 * visitor — so the whole internet shared one rate-limit bucket. Measured on
 * dev: a burst from one host 429'd a different, idle host's very next request.
 */
describe('getClientIp', () => {
    it('prefers CF-Connecting-IP over the proxy headers', () => {
        // The real shape behind Cloudflare + Traefik: x-real-ip is the edge,
        // cf-connecting-ip is the visitor. Picking the edge is the bug.
        expect(
            getClientIp(
                reqWith({
                    'cf-connecting-ip': '203.0.113.7',
                    'x-real-ip': '172.71.150.4',
                    'x-forwarded-for': '203.0.113.7, 172.71.150.4',
                }),
            ),
        ).toBe('203.0.113.7')
    })

    it('gives two visitors behind the same edge different keys', () => {
        const edge = { 'x-real-ip': '172.71.150.4' }
        const a = getClientIp(
            reqWith({ ...edge, 'cf-connecting-ip': '198.51.100.1' }),
        )
        const b = getClientIp(
            reqWith({ ...edge, 'cf-connecting-ip': '198.51.100.2' }),
        )
        expect(a).not.toBe(b)
    })

    it('falls back to X-Real-IP when Cloudflare is not in front', () => {
        expect(getClientIp(reqWith({ 'x-real-ip': '198.51.100.9' }))).toBe(
            '198.51.100.9',
        )
    })

    it('falls back to the first X-Forwarded-For entry', () => {
        expect(
            getClientIp(
                reqWith({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }),
            ),
        ).toBe('198.51.100.9')
    })

    it('ignores a whitespace-only header rather than keying on empty', () => {
        expect(
            getClientIp(
                reqWith({
                    'cf-connecting-ip': '   ',
                    'x-real-ip': '198.51.100.9',
                }),
            ),
        ).toBe('198.51.100.9')
    })

    it('meters under one shared key when no header identifies the caller', () => {
        expect(getClientIp(reqWith({}))).toBe('unknown')
    })
})
