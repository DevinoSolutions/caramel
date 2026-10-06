import { config, middleware } from '@/middleware'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

// next.config.mjs sets skipTrailingSlashRedirect so posthog-js's
// trailing-slash endpoints under the first-party telemetry prefix are not
// 308'd. That flag is global, so middleware.ts replaces Next's own behaviour
// for everything ELSE: `/foo/` -> `/foo` (308, query kept), never for `/` and
// never for the telemetry prefix. The pure rule is unit-tested in
// telemetry-proxy.test.ts; this pins it as wired into the middleware.

function requestFor(
    url: string,
    headers: Record<string, string> = {},
): NextRequest {
    const { host } = new URL(url)
    return new NextRequest(url, { headers: { host, ...headers } })
}

describe('middleware: trailing slash', () => {
    it('308s /coupons/ to /coupons and keeps the query string', () => {
        const res = middleware(
            requestFor('https://grabcaramel.com/coupons/?page=2&sort=best'),
        )
        expect(res.status).toBe(308)
        expect(res.headers.get('location')).toBe(
            'https://grabcaramel.com/coupons?page=2&sort=best',
        )
    })

    it('308s a nested path', () => {
        const res = middleware(
            requestFor('https://grabcaramel.com/coupons/nike.com/'),
        )
        expect(res.status).toBe(308)
        expect(res.headers.get('location')).toBe(
            'https://grabcaramel.com/coupons/nike.com',
        )
    })

    it('serves the root untouched', () => {
        const res = middleware(requestFor('https://grabcaramel.com/'))
        expect(res.status).not.toBe(308)
        expect(res.headers.get('location')).toBeNull()
    })

    it('serves a clean path untouched', () => {
        const res = middleware(requestFor('https://grabcaramel.com/coupons'))
        expect(res.status).not.toBe(308)
    })

    it('NEVER redirects the telemetry prefix: a 308 on a POST drops the event', () => {
        for (const path of [
            '/_t/k3v/i/v0/e/',
            '/_t/k3v/flags/',
            '/_t/k3v/s/',
        ]) {
            const res = middleware(
                requestFor(`https://grabcaramel.com${path}?ip=1&ver=1.405.3`),
            )
            expect(res.status).not.toBe(308)
            expect(res.headers.get('location')).toBeNull()
        }
    })

    it('a www + trailing-slash request redirects ONCE to the final URL', () => {
        const res = middleware(
            requestFor('https://www.grabcaramel.com/pricing/?x=1'),
        )
        expect(res.status).toBe(308)
        expect(res.headers.get('location')).toBe(
            'https://grabcaramel.com/pricing?x=1',
        )
    })

    it('an http + trailing-slash request redirects ONCE to the https final URL', () => {
        const res = middleware(
            requestFor('http://grabcaramel.com/faq/', {
                'cf-visitor': '{"scheme":"http"}',
            }),
        )
        expect(res.status).toBe(308)
        expect(res.headers.get('location')).toBe('https://grabcaramel.com/faq')
    })
})

describe('middleware matcher: page paths are covered, static assets are not', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    it('matches pages, API routes, the telemetry prefix and trailing-slash paths', () => {
        for (const path of [
            '/coupons/',
            '/welcome',
            '/api/ext/installed',
            '/_t/k3v/i/v0/e/',
            '/robots.txt',
            '/sitemap.xml',
        ]) {
            expect(matcher.test(path)).toBe(true)
        }
    })

    it('still excludes Next static assets and the favicon', () => {
        for (const path of [
            '/_next/static/chunks/a.js',
            '/_next/image?url=x',
            '/favicon.ico',
        ]) {
            expect(matcher.test(path)).toBe(false)
        }
    })
})
