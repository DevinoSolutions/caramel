import { refusesPageMethod, SENTRY_TUNNEL_PATH } from '@/lib/pageMethods'
import { middleware } from '@/middleware'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// T-7839 / CARAMEL-2S: crawlers POST to pages ("POST /app" from UA
// "crawler"), and Next answered by rendering /_not-found as an action
// response, then threw "Invariant: Expected RSC response, got text/plain"
// into Sentry. The app has no server actions, so the middleware now answers a
// write to a page with 405 before Next renders anything. The paths that take
// writes (the API, the PostHog prefix, the Sentry tunnel) keep every method.

function request(method: string, path: string): NextRequest {
    return new NextRequest(`https://grabcaramel.com${path}`, {
        method,
        headers: {
            host: 'grabcaramel.com',
            'cf-visitor': '{"scheme":"https"}',
        },
    })
}

describe('middleware — a write to a page is a 405', () => {
    it.each([
        ['POST', '/'],
        ['POST', '/app'],
        ['POST', '/_not-found'],
        ['POST', '/coupons/nike.com'],
        ['PUT', '/profile'],
        ['DELETE', '/login'],
        ['PATCH', '/stores'],
        ['POST', '/llms.txt'],
        ['POST', '/apiary'],
        // No route answers the bare /api: a POST there reached /_not-found
        // (CARAMEL-2S again, 2026-10-27, after the first guard shipped).
        ['POST', '/api'],
        ['POST', '/monitoringx'],
    ])('%s %s -> 405 with Allow', (method, path) => {
        const res = middleware(request(method, path))
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    })

    it.each([
        ['GET', '/'],
        ['HEAD', '/coupons/nike.com'],
        ['OPTIONS', '/profile'],
        ['POST', '/api/auth/callback/apple'],
        ['POST', '/api/account/savings'],
        ['DELETE', '/api/account'],
        ['POST', '/_t/k3v/i/v0/e/'],
        ['POST', '/monitoring'],
        ['POST', '/monitoring?o=1&p=5'],
    ])('%s %s is served', (method, path) => {
        const res = middleware(request(method, path))
        expect(res.status).not.toBe(405)
    })

    it('reads the method case-insensitively', () => {
        expect(refusesPageMethod('get', '/app')).toBe(false)
        expect(refusesPageMethod('post', '/app')).toBe(true)
    })
})

describe('the Sentry tunnel the guard keeps open', () => {
    it('is the tunnelRoute next.config.mjs gives the Sentry SDK', () => {
        const nextConfig = readFileSync(
            new URL('../../next.config.mjs', import.meta.url),
            'utf8',
        )
        const route = /tunnelRoute:\s*'([^']+)'/.exec(nextConfig)?.[1]
        expect(route).toBe(SENTRY_TUNNEL_PATH)
    })
})
