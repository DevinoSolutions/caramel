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

function expectDocsRedirect(res: Response, location: string): void {
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(location)
}

describe('middleware — docs host (docs.<apex> -> <apex>/docs, T-7855)', () => {
    it('301s the docs host root to the apex /docs over https', () => {
        expectDocsRedirect(
            middleware(requestFor('https://docs.grabcaramel.com/', CF_HTTPS)),
            'https://grabcaramel.com/docs',
        )
    })

    it('sends a deep path and its query to /docs, forwarding neither', () => {
        expectDocsRedirect(
            middleware(
                requestFor(
                    'https://docs.grabcaramel.com/getting-started/install?x=1',
                    CF_HTTPS,
                ),
            ),
            'https://grabcaramel.com/docs',
        )
    })

    it('redirects ONCE to https even when the docs host was plain http', () => {
        expectDocsRedirect(
            middleware(requestFor('http://docs.grabcaramel.com/', CF_HTTP)),
            'https://grabcaramel.com/docs',
        )
    })

    it('uses https behind the proxy even when the container sees http', () => {
        expectDocsRedirect(
            middleware(
                requestFor('http://docs.grabcaramel.com/x', {
                    'x-forwarded-proto': 'https',
                }),
            ),
            'https://grabcaramel.com/docs',
        )
    })

    it('keeps the local scheme and port in dev (docs.localhost:58000)', () => {
        expectDocsRedirect(
            middleware(requestFor('http://docs.localhost:58000/anything')),
            'http://localhost:58000/docs',
        )
    })

    it('leaves www and the apex exactly as they were', () => {
        expectRedirect(
            middleware(
                requestFor('https://www.grabcaramel.com/docs', CF_HTTPS),
            ),
            'https://grabcaramel.com/docs',
        )
        expectServed(
            middleware(requestFor('https://grabcaramel.com/docs', CF_HTTPS)),
        )
    })

    it('does not redirect other subdomains or look-alike hosts', () => {
        for (const host of [
            'faq.grabcaramel.com',
            'dev.grabcaramel.com',
            'mydocs.grabcaramel.com',
            'docs-grabcaramel.com',
        ]) {
            expectServed(middleware(requestFor(`https://${host}/`, CF_HTTPS)))
        }
    })

    it('a hostile Host header falls through as before', () => {
        for (const host of [
            'docs.evil.com/../x',
            'docs.grabcaramel.com@evil.com',
            'docs.',
            'docs..x',
            'docs.grabcaramel.com:99999999',
            // A syntactically valid foreign apex must never become a 301 to it.
            'docs.evil.com',
            'docs.grabcaramel.com.evil.com',
            // Numeric remainders used to reach new URL() and throw (a 500).
            'docs.999.1',
            'docs.x.9',
            'docs.1.1',
        ]) {
            const res = middleware(
                new NextRequest('https://grabcaramel.com/pricing', {
                    headers: { host },
                }),
            )
            expectServed(res)
        }
    })
})
