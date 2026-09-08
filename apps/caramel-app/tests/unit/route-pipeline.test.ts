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
//    characterizations, not new behavior. (Later delta: the mint's dead
//    bearer self-fetch was deleted — NF-07 — so the token pins are now
//    the RAW session token; in production that is what every mint had
//    ALWAYS returned, the mocked self-fetch success was unreachable in
//    reality.)

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
        // Deterministic session tokens so the raw session token the mint
        // returns (its only token path — NF-07 deleted the dead bearer
        // self-fetch) can be pinned to an EXACT value — real randomBytes
        // would make that assertion impossible. Buffer is a Node global
        // (not a node:crypto export), so it's used directly.
        randomBytes: (size: number) => Buffer.alloc(size, 7),
    }
})

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

// sites/suggest now declares `auth: 'optional'` (it attributes a suggestion to
// a signed-in requester), so withRoute lazy-imports the better-auth graph and
// resolves a session BEFORE the body gate this file pins. Stand the whole
// graph in with an always-anonymous session, exactly as coupons-report.test.ts
// does — the 422 below is about the body, not about auth.
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: vi.fn(async () => null) } },
}))

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
                }) => ({ ...prismaState.existingUser, id: where.id, ...data }),
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
    // NOTE deliberately NO branch for our own /api/auth/* here: the mint's
    // bearer self-fetch was deleted (NF-07), so any fetch back into our own
    // app is a regression and hits the throw below loudly.
    throw new Error(`route-pipeline.test.ts: unexpected fetch to ${url}`)
}

const fetchMock = vi.fn(defaultFetchImpl)

// The raw session token every mint returns — deterministic via the
// node:crypto randomBytes stub above (32 bytes of 0x07). NF-07: the raw
// token isn't a fallback anymore; it's the mint's only token path.
const RAW_SESSION_TOKEN = Buffer.alloc(32, 7).toString('base64url')

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    // mockReset (not mockClear) — a prior test's mockImplementation()
    // override (e.g. the NF-07 gate tests' provider-claim variants) persists
    // across tests otherwise, since mockClear only wipes call history, not
    // the implementation. Re-arming the default here every time is what
    // makes per-test overrides properly test-local.
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
    it('Google, brand-new user: 200 {token,username,image} with the raw session token, user/account/session all created once', async () => {
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
            token: RAW_SESSION_TOKEN,
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
        // NF-12 fixed: the mint now reassigns `user` to the
        // prisma.user.update() result, so the response carries Google's FRESH
        // picture rather than the stale pre-update `null`. username still
        // resolves to the existing `username` (Google carries none), so only
        // the image visibly refreshes in this pin.
        expect(await res.json()).toEqual({
            token: RAW_SESSION_TOKEN,
            username: 'oldusername',
            image: 'https://example.com/google-pic.png',
        })
        expect(prismaMock.user.create).not.toHaveBeenCalled()
        expect(prismaMock.user.update).toHaveBeenCalledTimes(1)
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
            token: RAW_SESSION_TOKEN,
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
                    // email_verified: true so this still exercises the
                    // email-required (400) path — NF-07's verified-email gate
                    // (403) now runs FIRST and would otherwise intercept a
                    // false claim (that ordering is pinned separately below).
                    id_token: buildAppleIdToken({
                        sub: 'apple-user-id-no-email',
                        email: null,
                        email_verified: true,
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

// NF-07 — the mint is gated on the PROVIDER's verified-email claim (Google
// userinfo `verified_email`; Apple ID-token `email_verified`, boolean OR the
// string "true"/"false"), mirroring better-auth's social-login semantics.
// Absent/false -> 403 with a named error, no user/session write. Present+true
// -> mint proceeds even when the local User row is emailVerified:false.
describe('extension/oauth (exchange) — emailVerified gate (NF-07)', () => {
    const redirectUri = 'https://abc123.chromiumapp.org/'

    function googleFetch(verifiedEmail: unknown, hasVerifiedKey = true) {
        return async (input: RequestInfo | URL) => {
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
                    picture: null,
                    ...(hasVerifiedKey
                        ? { verified_email: verifiedEmail }
                        : {}),
                })
            throw new Error(`unexpected fetch ${url}`)
        }
    }

    function appleFetch(emailVerified: unknown) {
        return async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('appleid.apple.com/auth/token'))
                return jsonResponse({
                    access_token: 'apple-access-token',
                    id_token: buildAppleIdToken({
                        sub: 'apple-user-id',
                        email: 'appleuser@example.com',
                        email_verified: emailVerified,
                    }),
                })
            throw new Error(`unexpected fetch ${url}`)
        }
    }

    function exchange(provider: 'google' | 'apple') {
        return oauthPOST(
            exchangeRequest({
                provider,
                code: 'auth-code',
                state: signState({ provider, redirectUri }),
                redirectUri,
            }),
        )
    }

    it('Google, verified_email false -> 403 named error, nothing minted', async () => {
        fetchMock.mockImplementation(googleFetch(false))
        const res = await exchange('google')
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({
            error: 'Your Google email address is not verified. Please verify it with Google and try again.',
        })
        expect(prismaMock.user.create).not.toHaveBeenCalled()
        expect(prismaMock.session.create).not.toHaveBeenCalled()
    })

    it('Google, verified_email absent -> 403 (claim required, not merely non-false)', async () => {
        fetchMock.mockImplementation(googleFetch(undefined, false))
        const res = await exchange('google')
        expect(res.status).toBe(403)
        expect(prismaMock.session.create).not.toHaveBeenCalled()
    })

    it('Apple, email_verified false -> 403 BEFORE the email-required check', async () => {
        fetchMock.mockImplementation(appleFetch(false))
        const res = await exchange('apple')
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({
            error: 'Your Apple email address is not verified. Please verify it with Apple and try again.',
        })
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })

    it("Apple, email_verified string 'false' -> 403 (string coercion handled, not truthy)", async () => {
        fetchMock.mockImplementation(appleFetch('false'))
        const res = await exchange('apple')
        expect(res.status).toBe(403)
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })

    it("Apple, email_verified string 'true' -> 200, user minted as verified", async () => {
        fetchMock.mockImplementation(appleFetch('true'))
        const res = await exchange('apple')
        expect(res.status).toBe(200)
        expect(prismaMock.user.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.user.create.mock.calls[0][0].data).toMatchObject({
            emailVerified: true,
            status: 'ACTIVE_USER',
        })
    })

    it('web-parity: provider claim true mints even when the local User row is emailVerified:false', async () => {
        prismaState.existingUser = {
            id: 'existing-user-id',
            email: 'googleuser@example.com',
            name: 'Google User',
            image: null,
            username: 'oldusername',
            emailVerified: false, // local row unverified — social flow signs in anyway
        }
        fetchMock.mockImplementation(googleFetch(true))
        const res = await exchange('google')
        expect(res.status).toBe(200)
        expect(prismaMock.user.create).not.toHaveBeenCalled()
        expect(prismaMock.session.create).toHaveBeenCalledTimes(1)
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
