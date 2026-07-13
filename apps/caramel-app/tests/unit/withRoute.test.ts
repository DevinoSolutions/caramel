import { preflight, withRoute } from '@/lib/api/withRoute'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// F-007 — withRoute unit tests (PLAN-F-007.md §Test strategy): each
// concern isolated from any specific route, against synthetic handlers.
// route-pipeline.test.ts covers the same mechanisms through real routes;
// this file is the wrapper's own contract.

// withRoute.ts reads env.CHROME_EXTENSION_ORIGIN into a MODULE-TOP-LEVEL
// const at import time (KNOWN_EXTENSION_ORIGINS) — the mock's value must
// already be correct in vi.hoisted's INITIAL object, not set later in
// beforeEach (see route-pipeline.test.ts's header comment for the full
// explanation of this closure-timing hazard).
const { envMock } = vi.hoisted(() => ({
    envMock: {
        CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-id' as
            | string
            | undefined,
        FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
        SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
        COUPONS_ADMIN_SECRET: 'test-admin-secret' as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { checkRateLimitMock } = vi.hoisted(() => ({
    checkRateLimitMock: vi.fn(async () => null as NextResponse | null),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    // isOriginAllowed/isTrustedServer/forbiddenOrigin stay REAL — they're
    // pure functions of (req, mocked env), exercising real logic is the
    // point. Only checkRateLimit (has side-effecting in-memory state) is
    // replaced for per-test control.
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: captureExceptionMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(async () => null as unknown),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

beforeEach(() => {
    checkRateLimitMock.mockClear()
    checkRateLimitMock.mockImplementation(async () => null)
    captureExceptionMock.mockClear()
    getSessionMock.mockClear()
    getSessionMock.mockImplementation(async () => null)
})

function makeReq(
    url = 'http://localhost/api/test',
    init: ConstructorParameters<typeof NextRequest>[1] = {},
): NextRequest {
    return new NextRequest(url, init)
}

const ok = async () => NextResponse.json({ ok: true })

describe('withRoute — cors', () => {
    it("cors: 'none' (default) — no CORS headers even with a known extension Origin", async () => {
        const handler = withRoute({ method: 'GET', routeName: 'test' }, ok)
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it("cors: 'extension' — reflects a known origin + sets Allow-Methods/Allow-Headers", async () => {
        const handler = withRoute(
            { method: 'GET', routeName: 'test', cors: 'extension' },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'chrome-extension://known-id',
        )
        expect(res.headers.get('Access-Control-Allow-Methods')).toBe(
            'GET, OPTIONS',
        )
        expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
            'Content-Type',
        )
    })

    it("cors: 'extension' — omits the header entirely for an unknown origin", async () => {
        const handler = withRoute(
            { method: 'GET', routeName: 'test', cors: 'extension' },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://unknown-id' },
            }),
        )
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it("cors: 'public' — reflects '*'", async () => {
        const handler = withRoute(
            { method: 'GET', routeName: 'test', cors: 'public' },
            ok,
        )
        const res = await handler(makeReq())
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('merges CORS onto an ERROR response too (matches pre-F-007 authorize/oauth attaching corsHeaders to their 4xx/500s)', async () => {
        const handler = withRoute(
            { method: 'GET', routeName: 'test', cors: 'extension' },
            async () => NextResponse.json({ error: 'nope' }, { status: 400 }),
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.status).toBe(400)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'chrome-extension://known-id',
        )
    })
})

describe('preflight()', () => {
    it('204 + Allow-Methods for a known origin', async () => {
        const handler = preflight({
            cors: 'extension',
            methods: 'POST, OPTIONS',
        })
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.status).toBe(204)
        expect(res.headers.get('Access-Control-Allow-Methods')).toBe(
            'POST, OPTIONS',
        )
    })

    it('204 with no CORS headers for an unrecognized origin', async () => {
        const handler = preflight({
            cors: 'extension',
            methods: 'POST, OPTIONS',
        })
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://unknown-id' },
            }),
        )
        expect(res.status).toBe(204)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
})

describe('withRoute — rateLimit', () => {
    it('delegates to checkRateLimit — a 429 from it passes through untouched, with CORS still merged', async () => {
        const limited = NextResponse.json(
            { error: 'Too many requests. Please slow down.' },
            { status: 429 },
        )
        checkRateLimitMock.mockImplementation(async () => limited)
        const handler = withRoute(
            {
                method: 'GET',
                routeName: 'test',
                rateLimit: 'read',
                cors: 'extension',
            },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.status).toBe(429)
        expect(checkRateLimitMock).toHaveBeenCalledWith(
            expect.anything(),
            'read',
        )
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'chrome-extension://known-id',
        )
    })

    it('omitted (undefined) — never calls checkRateLimit at all', async () => {
        const handler = withRoute({ method: 'GET', routeName: 'test' }, ok)
        await handler(makeReq())
        expect(checkRateLimitMock).not.toHaveBeenCalled()
    })
})

describe('withRoute — origin gate', () => {
    it('origin: true, cross-origin request from a random website -> 403 Forbidden origin', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', origin: true },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: {
                    origin: 'https://evil.example.com',
                    host: 'localhost',
                },
            }),
        )
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden origin' })
    })

    it('origin: true, same-origin request -> passes through to the handler', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', origin: true },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { host: 'localhost' },
            }),
        )
        expect(res.status).toBe(200)
    })

    // D5 (E2E report) — origin: true's isOriginAllowed() intentionally lets
    // a request with NO Origin header through (server-to-server/curl), which
    // is correct for most mutation routes but left classify-cart (a paid
    // LLM-backed endpoint meant to be extension-only) reachable origin-less.
    // origin: 'extension' is the stricter mode: Origin must be PRESENT and
    // be an actual browser-extension protocol — no missing-Origin bypass,
    // no same-origin exemption.
    describe('origin: "extension" — strict, no missing-Origin bypass (D5 fix)', () => {
        it('missing Origin -> 403 (exactly the hole origin: true leaves open)', async () => {
            const handler = withRoute(
                { method: 'POST', routeName: 'test', origin: 'extension' },
                ok,
            )
            const res = await handler(
                makeReq('http://localhost/api/test', { method: 'POST' }),
            )
            expect(res.status).toBe(403)
            expect(await res.json()).toEqual({ error: 'Forbidden origin' })
        })

        it('a same-origin request -> still 403 (stricter than origin: true — must be an extension)', async () => {
            const handler = withRoute(
                { method: 'POST', routeName: 'test', origin: 'extension' },
                ok,
            )
            const res = await handler(
                makeReq('http://localhost/api/test', {
                    method: 'POST',
                    headers: { host: 'localhost' },
                }),
            )
            expect(res.status).toBe(403)
        })

        it('a chrome-extension:// Origin (any id) -> passes through to the handler', async () => {
            const handler = withRoute(
                { method: 'POST', routeName: 'test', origin: 'extension' },
                ok,
            )
            const res = await handler(
                makeReq('http://localhost/api/test', {
                    method: 'POST',
                    headers: { origin: 'chrome-extension://some-id' },
                }),
            )
            expect(res.status).toBe(200)
        })
    })
})

describe('withRoute — apiKey', () => {
    it("apiKey: 'trustedServer', missing/wrong bearer -> 401", async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', apiKey: 'trustedServer' },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', { method: 'POST' }),
        )
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthorized' })
    })

    it("apiKey: 'trustedServer', correct bearer -> passes through", async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', apiKey: 'trustedServer' },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { authorization: 'Bearer test-admin-secret' },
            }),
        )
        expect(res.status).toBe(200)
    })
})

describe("withRoute — auth: 'session' (implemented + tested; zero current routes use it)", () => {
    it('null session -> 401, without ever needing the real better-auth module', async () => {
        getSessionMock.mockImplementation(async () => null)
        const handler = withRoute(
            { method: 'GET', routeName: 'test', auth: 'session' },
            async ({ session }) => NextResponse.json({ session }),
        )
        const res = await handler(makeReq())
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('a resolved session is passed to the handler', async () => {
        const fakeSession = { session: { id: 's1' }, user: { id: 'u1' } }
        getSessionMock.mockImplementation(async () => fakeSession)
        const handler = withRoute(
            { method: 'GET', routeName: 'test', auth: 'session' },
            async ({ session }) => NextResponse.json({ session }),
        )
        const res = await handler(makeReq())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ session: fakeSession })
    })
})

describe('withRoute — body', () => {
    const Schema = z.object({ name: z.string().min(1) })

    it('invalid body -> 422 {error}', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ body }),
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            }),
        )
        expect(res.status).toBe(422)
        expect(await res.json()).toEqual({ error: 'Invalid request body' })
    })

    it('valid body -> typed and handed to the handler', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ body }),
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'x' }),
            }),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ body: { name: 'x' } })
    })

    it('unparseable JSON against a schema requiring a field -> 422, not a 500', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ body }),
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not json {{{',
            }),
        )
        expect(res.status).toBe(422)
    })

    it('body omitted (default) -> handler gets undefined, wrapper never calls req.json()', async () => {
        const handler = withRoute(
            { method: 'POST', routeName: 'test' },
            async ({ body }) =>
                NextResponse.json({ body: body ?? 'undefined' }),
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not json {{{',
            }),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ body: 'undefined' })
    })
})

describe('withRoute — handler throw -> F-002 handleRouteError', () => {
    it('reports to Sentry, returns {error}+500+x-request-id, and merges CORS', async () => {
        const handler = withRoute(
            { method: 'GET', routeName: 'my-test-route', cors: 'extension' },
            async () => {
                throw new Error('boom')
            },
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                headers: { origin: 'chrome-extension://known-id' },
            }),
        )
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Internal server error' })
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'chrome-extension://known-id',
        )
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [, context] = captureExceptionMock.mock.calls[0]
        expect(context.tags.route).toBe('my-test-route')
    })
})

describe('withRoute — concern order', () => {
    it('origin-gate runs before apiKey — a request failing both gets 403, not 401 (mirrors coupons/expire)', async () => {
        const handler = withRoute(
            {
                method: 'POST',
                routeName: 'test',
                origin: true,
                apiKey: 'trustedServer',
            },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: {
                    origin: 'https://evil.example.com',
                    host: 'localhost',
                },
            }),
        )
        expect(res.status).toBe(403)
    })

    it('rateLimit runs before body validation — a rate-limited request never reaches body parsing', async () => {
        const limited = NextResponse.json(
            { error: 'slow down' },
            { status: 429 },
        )
        checkRateLimitMock.mockImplementation(async () => limited)
        const Schema = z.object({ name: z.string().min(1) })
        const handler = withRoute(
            {
                method: 'POST',
                routeName: 'test',
                rateLimit: 'mutation',
                body: Schema,
            },
            ok,
        )
        const res = await handler(
            makeReq('http://localhost/api/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}), // would 422 if body validation ran
            }),
        )
        expect(res.status).toBe(429)
    })
})
