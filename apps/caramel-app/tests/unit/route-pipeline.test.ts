import { POST as classifyCartPOST } from '@/app/api/classify-cart/route'
import { POST as incrementPOST } from '@/app/api/coupons/increment/route'
import { POST as loginPOST } from '@/app/api/extension/login/route'
import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import {
    GET as redirectGET,
    POST as redirectPOST,
} from '@/app/api/extension/oauth/redirect/route'
import { POST as oauthPOST } from '@/app/api/extension/oauth/route'
import { POST as suggestPOST } from '@/app/api/sites/suggest/route'
import { POST as sourcesPOST } from '@/app/api/sources/route'
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-007 — route-pipeline pins (PLAN-F-007.md §Test strategy). Two jobs:
//
// 1. Prove the withRoute migration is behavior-preserving for routes that
//    had NO prior test coverage at all (increment's origin gate, sources'
//    website validation, suggest's brand-new rate-limit/origin/body,
//    login's brand-new rate-limit/body, authorize/redirect's wrapping).
// 2. Characterize extension/oauth's (exchange) raw-Prisma session mint —
//    the plan's single riskiest step. These pins were run GREEN against
//    the UNMODIFIED route (batch 4a) BEFORE the mint was extracted into
//    extensionOAuthSession.ts (4b) and BEFORE the route was wrapped in
//    withRoute (4c) — the {token,username,image} shape, the CORS
//    reflection, and every 400 in this file are wire-identical
//    characterizations, not new behavior.

// NOTE: oauth/route.ts and oauth/authorize/route.ts both read
// env.EXTENSION_OAUTH_STATE_SECRET / env.CHROME_EXTENSION_ORIGIN into a
// MODULE-TOP-LEVEL `const` (`const OAUTH_STATE_SECRET = env.X`) — a
// one-time snapshot taken the instant the module is first imported, NOT a
// live read of the env object. A beforeEach() that assigns envMock.X
// AFTER that import has already happened is too late (the module already
// captured `undefined`). So the mock's env values must be correct in the
// vi.hoisted() INITIAL object itself, before any `import` in this file
// runs — same closure-timing hazard documented in
// coupons-visibility.test.ts, different mechanism (module-load-time
// snapshot vs. a captured function reference).
const { envMock, OAUTH_STATE_SECRET, KNOWN_ORIGIN } = vi.hoisted(() => {
    const OAUTH_STATE_SECRET = 'test-oauth-state-secret-F007'
    const KNOWN_ORIGIN = 'chrome-extension://known-extension-id-F007'
    return {
        OAUTH_STATE_SECRET,
        KNOWN_ORIGIN,
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: OAUTH_STATE_SECRET as
                | string
                | undefined,
            GOOGLE_CLIENT_ID: 'test-google-client-id' as string | undefined,
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret' as
                | string
                | undefined,
            APPLE_CLIENT_ID: 'test-apple-client-id' as string | undefined,
            APPLE_CLIENT_SECRET: 'test-apple-client-secret' as
                | string
                | undefined,
            BETTER_AUTH_URL: 'http://localhost:58000',
            CHROME_EXTENSION_ORIGIN: KNOWN_ORIGIN as string | undefined,
            FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
            SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
            COUPONS_ADMIN_SECRET: undefined as string | undefined,
        },
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))

vi.mock('node:crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('node:crypto')>()
    return {
        ...actual,
        // Deterministic session tokens so the raw-token fallback path (the
        // bearer self-fetch failing) can be pinned to an EXACT value —
        // real randomBytes would make that assertion impossible. Buffer is
        // a Node global (not a node:crypto export), so it's used directly.
        randomBytes: (size: number) => Buffer.alloc(size, 7),
    }
})

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const { prismaMock, prismaState } = vi.hoisted(() => {
    const prismaState = {
        existingUser: null as Record<string, unknown> | null,
        existingAccount: null as Record<string, unknown> | null,
    }
    const prismaMock = {
        user: {
            findFirst: vi.fn(async () => prismaState.existingUser),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-user-id',
                    username: null,
                    ...data,
                }),
            ),
            update: vi.fn(
                async ({
                    where,
                    data,
                }: {
                    where: { id: string }
                    data: Record<string, unknown>
                }) => ({ id: where.id, ...data }),
            ),
        },
        account: {
            findUnique: vi.fn(async () => prismaState.existingAccount),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-account-id',
                    ...data,
                }),
            ),
            update: vi.fn(
                async ({
                    where,
                    data,
                }: {
                    where: { id: string }
                    data: Record<string, unknown>
                }) => ({ id: where.id, ...data }),
            ),
        },
        session: {
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-session-id',
                    ...data,
                }),
            ),
        },
    }
    return { prismaMock, prismaState }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

function signState(payload: {
    provider: 'google' | 'apple'
    redirectUri: string
    iat?: number
}): string {
    const data = JSON.stringify({
        provider: payload.provider,
        redirectUri: payload.redirectUri,
        iat: payload.iat ?? Date.now(),
    })
    const sig = createHmac('sha256', OAUTH_STATE_SECRET)
        .update(data)
        .digest('base64url')
    return `${Buffer.from(data).toString('base64url')}.${sig}`
}

function buildAppleIdToken(payload: Record<string, unknown>): string {
    const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
    ).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.fake-signature`
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

async function defaultFetchImpl(input: RequestInfo | URL): Promise<Response> {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({
            access_token: 'google-access-token',
            id_token: 'google-id-token',
        })
    }
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return jsonResponse({
            id: 'google-user-id',
            email: 'googleuser@example.com',
            name: 'Google User',
            picture: 'https://example.com/google-pic.png',
            verified_email: true,
        })
    }
    if (url.includes('appleid.apple.com/auth/token')) {
        return jsonResponse({
            access_token: 'apple-access-token',
            id_token: buildAppleIdToken({
                sub: 'apple-user-id',
                email: 'appleuser@example.com',
                email_verified: true,
            }),
        })
    }
    if (url.includes('/api/auth/session')) {
        return new Response(null, {
            status: 200,
            headers: { 'set-auth-token': 'bearer-token-xyz' },
        })
    }
    throw new Error(`route-pipeline.test.ts: unexpected fetch to ${url}`)
}

const fetchMock = vi.fn(defaultFetchImpl)

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    // mockReset (not mockClear) — a prior test's mockImplementation()
    // override (e.g. "bearer self-fetch fails") persists across tests
    // otherwise, since mockClear only wipes call history, not the
    // implementation. Re-arming the default here every time is what makes
    // per-test overrides properly test-local.
    fetchMock.mockReset()
    fetchMock.mockImplementation(defaultFetchImpl)
    prismaState.existingUser = null
    prismaState.existingAccount = null
    prismaMock.user.findFirst.mockClear()
    prismaMock.user.create.mockClear()
    prismaMock.user.update.mockClear()
    prismaMock.account.findUnique.mockClear()
    prismaMock.account.create.mockClear()
    prismaMock.account.update.mockClear()
    prismaMock.session.create.mockClear()
    envMock.EXTENSION_OAUTH_STATE_SECRET = OAUTH_STATE_SECRET
    envMock.GOOGLE_CLIENT_ID = 'test-google-client-id'
    envMock.GOOGLE_CLIENT_SECRET = 'test-google-client-secret'
    envMock.APPLE_CLIENT_ID = 'test-apple-client-id'
    envMock.APPLE_CLIENT_SECRET = 'test-apple-client-secret'
    envMock.CHROME_EXTENSION_ORIGIN = KNOWN_ORIGIN
    envMock.FIREFOX_EXTENSION_ORIGIN = undefined
    envMock.SAFARI_EXTENSION_ORIGIN = undefined
    envMock.COUPONS_ADMIN_SECRET = undefined
})

function exchangeRequest(
    body: Record<string, unknown>,
    origin: string | null = KNOWN_ORIGIN,
) {
    return new NextRequest('http://localhost/api/extension/oauth', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
    })
}

describe('extension/oauth (exchange) — mint characterization (F-007 4a/4b/4c)', () => {
    it('Google, brand-new user: 200 {token,username,image} via the bearer self-fetch, user/account/session all created once', async () => {
        const redirectUri = 'https://abc123.chromiumapp.org/'
        const state = signState({ provider: 'google', redirectUri })

        const res = await oauthPOST(
            exchangeRequest({
                provider: 'google',
                code: 'auth-code',
                state,
                redirectUri,
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            token: 'bearer-token-xyz',
            username: 'Google User',
            image: 'https://example.com/google-pic.png',
        })
        expect(prismaMock.user.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.user.create.mock.calls[0][0].data).toMatchObject({
            email: 'googleuser@example.com',
            name: 'Google User',
            image: 'https://example.com/google-pic.png',
            emailVerified: true,
            status: 'ACTIVE_USER',
        })
        expect(prismaMock.account.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.session.create).toHaveBeenCalledTimes(1)
    })

    it('Google, existing user (found by email): updates the user, does not re-create', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'googleuser@example.com',
            name: 'Old Name',
            image: null,
            username: 'oldusername',
            emailVerified: false,
        }
        const redirectUri = 'https://abc123.chromiumapp.org/'
        const state = signState({ provider: 'google', redirectUri })

        const res = await oauthPOST(
            exchangeRequest({
                provider: 'google',
                code: 'auth-code',
                state,
                redirectUri,
            }),
        )

        expect(res.status).toBe(200)
        // image stays the PRE-update `null`, not Google's fresh picture —
        // wire-identical characterization of a genuine pre-existing quirk:
        // the route never re-reads `user` after prisma.user.update(), so
        // the response is built from the STALE findFirst() result even
        // though the DB row itself gets the new image. Preserved as-is
        // (not this fix's concern — only the mint's LOCATION moved).
        expect(await res.json()).toEqual({
            token: 'bearer-token-xyz',
            username: 'oldusername',
            image: null,
        })
        expect(prismaMock.user.create).not.toHaveBeenCalled()
        expect(prismaMock.user.update).toHaveBeenCalledTimes(1)
    })

    it('bearer self-fetch fails (non-ok) -> falls back to the raw session token, not null/undefined', async () => {
        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('oauth2.googleapis.com/token'))
                return jsonResponse({
                    access_token: 'google-access-token',
                    id_token: 'google-id-token',
                })
            if (url.includes('googleapis.com/oauth2/v2/userinfo'))
                return jsonResponse({
                    id: 'google-user-id',
                    email: 'googleuser@example.com',
                    name: 'Google User',
                    picture: 'https://example.com/google-pic.png',
                    verified_email: true,
                })
            if (url.includes('/api/auth/session'))
                return new Response(null, { status: 401 })
            throw new Error(`unexpected fetch ${url}`)
        })
        const redirectUri = 'https://abc123.chromiumapp.org/'
        const state = signState({ provider: 'google', redirectUri })

        const res = await oauthPOST(
            exchangeRequest({
                provider: 'google',
                code: 'auth-code',
                state,
                redirectUri,
            }),
        )

        expect(res.status).toBe(200)
        const json = await res.json()
        // Deterministic thanks to the randomBytes(size) => Buffer.alloc(size, 7) stub.
        expect(json.token).toBe(Buffer.alloc(32, 7).toString('base64url'))
    })

    it('Apple, brand-new user with email: 200, username falls through to email (Apple never gives a name)', async () => {
        const redirectUri = 'https://abc123.chromiumapp.org/'
        const state = signState({ provider: 'apple', redirectUri })

        const res = await oauthPOST(
            exchangeRequest({
                provider: 'apple',
                code: 'auth-code',
                state,
                redirectUri,
            }),
        )

        expect(res.status).toBe(200)
        // username: user.username || user.name || user.email || null — for
        // a brand-new Apple user, username and name are both null (Apple's
        // ID token never carries a name), so this correctly falls through
        // to the email, not to a bare `null`.
        expect(await res.json()).toEqual({
            token: 'bearer-token-xyz',
            username: 'appleuser@example.com',
            image: null,
        })
        expect(prismaMock.user.create.mock.calls[0][0].data).toMatchObject({
            email: 'appleuser@example.com',
            emailVerified: true,
            status: 'ACTIVE_USER',
        })
    })

    it('Apple, no email + no existing account: 400 "Email is required for Apple sign-in..." (unchanged message)', async () => {
        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('appleid.apple.com/auth/token'))
                return jsonResponse({
                    access_token: 'apple-access-token',
                    id_token: buildAppleIdToken({
                        sub: 'apple-user-id-no-email',
                        email: null,
                        email_verified: false,
                    }),
                })
            throw new Error(`unexpected fetch ${url}`)
        })
        const redirectUri = 'https://abc123.chromiumapp.org/'
        const state = signState({ provider: 'apple', redirectUri })

        const res = await oauthPOST(
            exchangeRequest({
                provider: 'apple',
                code: 'auth-code',
                state,
                redirectUri,
            }),
        )

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Email is required for Apple sign-in. Please ensure you grant email access.',
        })
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })

    // 400->422: PLAN-F-007.md §Breaking's flagged change — missing/invalid
    // provider or code is now a body-shape rejection (wrapper's generic
    // 422), not this route's old hand-written 400 checks (which are gone
    // — superseded by OAuthExchangeBodySchema). Consumers check
    // `resp.ok`, not the exact 4xx (verified: popup.js only branches on
    // `!oauthResponse.ok`).
    it('missing provider/code -> 422 (was 400 "Missing provider or code")', async () => {
        const res = await oauthPOST(exchangeRequest({}))
        expect(res.status).toBe(422)
    })

    it('invalid provider -> 422 (was 400 "Invalid provider...")', async () => {
        const res = await oauthPOST(
            exchangeRequest({
                provider: 'facebook',
                code: 'x',
                state: 'x',
                redirectUri: 'https://abc123.chromiumapp.org/',
            }),
        )
        expect(res.status).toBe(422)
    })

    it('missing/invalid signed state -> 400 "Invalid or expired OAuth state"', async () => {
        const res = await oauthPOST(
            exchangeRequest({
                provider: 'google',
                code: 'x',
                state: 'garbage',
                redirectUri: 'https://abc123.chromiumapp.org/',
            }),
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Invalid or expired OAuth state',
        })
    })

    it('known extension Origin -> Access-Control-Allow-Origin reflects it (even on a 400)', async () => {
        const res = await oauthPOST(exchangeRequest({}, KNOWN_ORIGIN))
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            KNOWN_ORIGIN,
        )
    })

    it('unknown Origin -> no Access-Control-Allow-Origin header', async () => {
        const res = await oauthPOST(
            exchangeRequest({}, 'chrome-extension://some-other-unknown-id'),
        )
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
})

describe('extension/oauth/authorize — CORS + rate-limit (F-007)', () => {
    function authorizeRequest(
        params: Record<string, string>,
        origin: string | null = KNOWN_ORIGIN,
    ) {
        const url = new URL('http://localhost/api/extension/oauth/authorize')
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
        return new NextRequest(url, {
            headers: origin ? { origin } : {},
        })
    }

    it('happy path: 200 with authorizationUrl + state, CORS reflects known origin', async () => {
        const res = await authorizeGET(
            authorizeRequest({
                provider: 'google',
                redirect_uri: 'https://abc123.chromiumapp.org/',
            }),
        )
        expect(res.status).toBe(200)
        const json = await res.json()
        expect(typeof json.authorizationUrl).toBe('string')
        expect(typeof json.state).toBe('string')
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            KNOWN_ORIGIN,
        )
    })

    it('missing provider -> 400 "Missing provider parameter"', async () => {
        const res = await authorizeGET(
            authorizeRequest({
                redirect_uri: 'https://abc123.chromiumapp.org/',
            }),
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Missing provider parameter',
        })
    })

    it('missing redirect_uri -> 400', async () => {
        const res = await authorizeGET(authorizeRequest({ provider: 'google' }))
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Missing redirect_uri parameter',
        })
    })
})

describe('extension/oauth/redirect — error boundary, no rate-limit (F-007)', () => {
    it('GET with code+state -> redirects to the extension redirect URI', async () => {
        const req = new NextRequest(
            'http://localhost/api/extension/oauth/redirect?code=abc&state=xyz&extension_redirect=' +
                encodeURIComponent('https://abc123.chromiumapp.org/'),
        )
        const res = await redirectGET(req)
        expect(res.status).toBe(307)
        const location = res.headers.get('location')
        expect(location).toContain('abc123.chromiumapp.org')
        expect(location).toContain('code=abc')
    })

    it('missing code -> 400', async () => {
        const req = new NextRequest(
            'http://localhost/api/extension/oauth/redirect',
        )
        const res = await redirectGET(req)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Missing authorization code',
        })
    })

    it('malformed POST body (not form data) is caught by the wrapper, not an unhandled rejection', async () => {
        const req = new NextRequest(
            'http://localhost/api/extension/oauth/redirect',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not valid form data {{{',
            },
        )
        const res = await redirectPOST(req)
        expect([400, 500]).toContain(res.status)
    })
})

describe('extension/login — NEW rate-limit + strict body (F-007)', () => {
    it('missing email/password -> 422 (was 400)', async () => {
        const req = new NextRequest('http://localhost/api/extension/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        })
        const res = await loginPOST(req)
        expect(res.status).toBe(422)
    })
})

describe('sites/suggest — NEW rate-limit + origin + strict body (F-007)', () => {
    it('missing url -> 422 (was 400 "Missing url")', async () => {
        const req = new NextRequest('http://localhost/api/sites/suggest', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        })
        const res = await suggestPOST(req)
        expect(res.status).toBe(422)
    })
})

describe('coupons/increment — origin gate (F-007, pre-existing concern now via the wrapper)', () => {
    it('cross-origin request from a random website -> 403', async () => {
        const req = new NextRequest(
            'http://localhost/api/coupons/increment?id=1',
            {
                method: 'POST',
                headers: { origin: 'https://evil.example.com' },
            },
        )
        const res = await incrementPOST(req)
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden origin' })
    })
})

describe('sources POST — strict website presence (F-007 NEW 422), plausibility stays a custom 400', () => {
    it('missing website -> 422 (was 400 "Missing required fields.")', async () => {
        const req = new NextRequest('http://localhost/api/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        })
        const res = await sourcesPOST(req)
        expect(res.status).toBe(422)
    })
})

// D5 (E2E report) — classify-cart is a paid LLM-backed endpoint meant to be
// reachable ONLY from the extension's background service worker (confirmed:
// background.js's classifyCart handler is the sole caller — a repo-wide
// grep of apps/caramel-app/src finds classify-cart referenced nowhere
// outside this route + withRoute.ts's own doc comment, i.e. no web-app page
// calls it). A request with NO Origin header used to return 200
// (isOriginAllowed's deliberate server-to-server bypass) — this route now
// uses origin: 'extension', which requires the Origin to be present and be
// an actual browser-extension protocol. Real extension calls are
// unaffected: they originate from background.js's service-worker fetch,
// and per Fetch/extension semantics the browser stamps those with
// `Origin: chrome-extension://<id>` automatically — verified no-mock in
// withRoute.test.ts's "extension" origin-gate suite.
describe('classify-cart — strict extension-origin gate (D5 fix)', () => {
    it('no Origin header -> 403 Forbidden origin (was 200 — the paid endpoint was reachable origin-less)', async () => {
        const req = new NextRequest('http://localhost/api/classify-cart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ domain: 'example.com' }),
        })
        const res = await classifyCartPOST(req)
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden origin' })
    })

    it('a same-origin (non-extension) request -> also 403', async () => {
        const req = new NextRequest('http://localhost/api/classify-cart', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                host: 'localhost',
            },
            body: JSON.stringify({ domain: 'example.com' }),
        })
        const res = await classifyCartPOST(req)
        expect(res.status).toBe(403)
    })
})
