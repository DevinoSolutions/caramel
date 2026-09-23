import { config, middleware } from '@/middleware'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

// Pins src/middleware.ts's canonical-origin contract. Two redirects, both
// 308, both ending on the https apex:
//   - www.grabcaramel.com -> grabcaramel.com (host)
//   - http -> https, decided ONLY from Cloudflare's `cf-visitor` header
// and — the load-bearing negative — NEVER from `x-forwarded-proto`: Next
// synthesises that header and Traefik rewrites it to the origin-side scheme,
// so a redirect keyed on it loops behind the proxy. Measured 2026-09-11:
// http://grabcaramel.com/ served 200 (zone "Always Use HTTPS" off).

function requestFor(
    url: string,
    headers: Record<string, string> = {},
): NextRequest {
    const { host } = new URL(url)
    return new NextRequest(url, { headers: { host, ...headers } })
}

const CF_HTTP = { 'cf-visitor': '{"scheme":"http"}' }
const CF_HTTPS = { 'cf-visitor': '{"scheme":"https"}' }

function expectServed(res: Response): void {
    expect(res.status).not.toBe(308)
    expect(res.headers.get('location')).toBeNull()
}

function expectRedirect(res: Response, location: string): void {
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(location)
}

describe('middleware — canonical origin (www -> apex, http -> https)', () => {
    it('serves an https apex request untouched', () => {
        expectServed(
            middleware(requestFor('https://grabcaramel.com/coupons', CF_HTTPS)),
        )
    })

    it('serves a request with NO cf-visitor header (direct-to-origin, local, CI)', () => {
        expectServed(middleware(requestFor('http://localhost:58000/pricing')))
    })

    it('redirects a plain-http request (cf-visitor scheme http) to https, same path + query', () => {
        expectRedirect(
            middleware(
                requestFor(
                    'http://grabcaramel.com/coupons/nike.com?page=2&sort=best',
                    CF_HTTP,
                ),
            ),
            'https://grabcaramel.com/coupons/nike.com?page=2&sort=best',
        )
    })

    it('redirects www to the apex over https', () => {
        expectRedirect(
            middleware(
                requestFor('https://www.grabcaramel.com/pricing', CF_HTTPS),
            ),
            'https://grabcaramel.com/pricing',
        )
    })

    it('a www + http request redirects ONCE, straight to the https apex', () => {
        expectRedirect(
            middleware(
                requestFor('http://www.grabcaramel.com/sources?x=1', CF_HTTP),
            ),
            'https://grabcaramel.com/sources?x=1',
        )
    })

    it('NEVER redirects on x-forwarded-proto alone (Traefik rewrites it — a fallback loops)', () => {
        expectServed(
            middleware(
                requestFor('http://grabcaramel.com/', {
                    'x-forwarded-proto': 'http',
                }),
            ),
        )
    })

    it('an unexpected cf-visitor value is treated as "not plain http", never as an error', () => {
        expectServed(
            middleware(
                requestFor('https://grabcaramel.com/', {
                    'cf-visitor': 'not-json',
                }),
            ),
        )
    })

    it('matcher keeps Next internals and static assets out of the redirect path', () => {
        const [pattern] = config.matcher
        // Anchored the way Next compiles it: the group must consume the whole
        // pathname after the leading slash.
        const matcher = new RegExp(`^${pattern}$`)
        expect(matcher.test('/coupons/nike.com')).toBe(true)
        expect(matcher.test('/api/health')).toBe(true)
        expect(matcher.test('/_next/static/chunks/main.js')).toBe(false)
        expect(matcher.test('/_next/image?url=x')).toBe(false)
        expect(matcher.test('/favicon.ico')).toBe(false)
    })
})
