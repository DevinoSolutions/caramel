import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import { GET as pollGET } from '@/app/api/extension/oauth/poll/route'
import {
    GET as redirectGET,
    POST as redirectPOST,
} from '@/app/api/extension/oauth/redirect/route'
import { POST as oauthPOST } from '@/app/api/extension/oauth/route'
import { resetNonceStoreForTests } from '@/lib/extension-oauth-nonce'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// COMPATIBILITY SHIM for the shipped Safari/iOS build (store version published
// 2026-04-29): remove this suite together with the shim.
// TODO(safari-shim-removal)
// ============================================================================
//
// The published Safari/iOS extension cannot capture an OAuth redirect, so it
// hands /authorize a nonce, lets /redirect finish the exchange server-side, and
// polls /poll for the session token. The dev tree deleted all three halves; this
// suite pins the shim that brings them back, against the contract the SHIPPED
// client actually implements (apps/caramel-extension/popup.js on the `main`
// tree):
//
//   popup.js:150-168  204 = pending · 2xx+{token} = done · 2xx without token =
//                     "Empty response from poll" · anything else = error body's
//                     `.error`
//   popup.js:170-178  re-polls every 2000ms until a locally-stored deadline
//   popup.js:264-273  nonce = crypto.randomUUID(), passed to authorize as
//                     `&nonce=`, redirect_uri = OUR /oauth/redirect
//   popup.js:126      client-side TTL of 5 minutes
//
// Verified against LIVE prod on 2026-08-08: unknown nonce -> 204 empty, absent
// nonce -> 400 {"error":"Missing or invalid nonce"}.
//
// The happy path here is deliberately NOT a stubbed handoff: the loopback POST
// the shim makes is routed into the REAL /api/extension/oauth handler in-process
// (see `fetchImpl`), so the token /poll returns is one the production mint
// actually produced, not a fixture.

const { envMock, KNOWN_ORIGIN, BASE } = vi.hoisted(() => {
    const KNOWN_ORIGIN = 'safari-web-extension://known-safari-extension-id'
    const BASE = 'http://localhost:58000'
    return {
        KNOWN_ORIGIN,
        BASE,
        // Module-top-level `const OAUTH_STATE_SECRET = env.X` snapshots at
        // import time, so these must be right in the hoisted object itself —
        // the same timing hazard route-pipeline.test.ts documents.
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: 'test-oauth-state-secret-safari-shim',
            GOOGLE_CLIENT_ID: 'test-google-client-id',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
            APPLE_CLIENT_ID: 'test-apple-client-id',
            APPLE_CLIENT_SECRET: 'test-apple-client-secret',
            BETTER_AUTH_URL: BASE,
            CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-chrome-id',
            FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
            SAFARI_EXTENSION_ORIGIN: KNOWN_ORIGIN as string | undefined,
            COUPONS_ADMIN_SECRET: undefined as string | undefined,
        },
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: BASE }))

// The shipped client polls once every 2s for up to 5 minutes; the real limiter
// would make that a test-ordering variable. Its own behavior is pinned in
// rateLimit.test.ts — here it is out of scope.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

vi.mock('node:crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('node:crypto')>()
    // Deterministic session token so the value /poll hands back can be pinned
    // to an exact string rather than merely "some token".
    return { ...actual, randomBytes: (size: number) => Buffer.alloc(size, 7) }
})
const EXPECTED_SESSION_TOKEN = Buffer.alloc(32, 7).toString('base64url')

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        user: {
            findFirst: vi.fn(async () => null),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-user-id',
                    username: null,
                    ...data,
                }),
            ),
            update: vi.fn(async () => ({ id: 'new-user-id' })),
        },
        account: {
            findUnique: vi.fn(async () => null),
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-account-id',
                    ...data,
                }),
            ),
            update: vi.fn(async () => ({ id: 'new-account-id' })),
        },
        session: {
            create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => ({
                    id: 'new-session-id',
                    ...data,
                }),
            ),
        },
    },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const SAFARI_REDIRECT_URI = `${BASE}/api/extension/oauth/redirect`
const CHROME_REDIRECT_URI =
    'https://bncdbnjkcbemlmoaflgnpoghogadlgce.chromiumapp.org/'
/** What the shipped popup generates: crypto.randomUUID(), 36 chars. */
const NONCE = '3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30'

/** Routes the shim's loopback POST into the REAL exchange handler, and answers
 * Google's token/userinfo calls that the handler makes in turn. */
function installFetchImpl(options: { googleEmailVerified?: boolean } = {}) {
    const impl = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()

            if (url === 'https://oauth2.googleapis.com/token') {
                return Response.json({
                    access_token: 'fake-google-access-token',
                    id_token: 'fake-google-id-token',
                })
            }
            if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
                return Response.json({
                    id: 'google-user-123',
                    email: 'safari-shim@example.com',
                    name: 'Safari Shim',
                    picture: 'https://example.com/avatar.png',
                    verified_email: options.googleEmailVerified ?? true,
                })
            }
            if (url === `${BASE}/api/extension/oauth`) {
                return oauthPOST(
                    new NextRequest(url, {
                        method: 'POST',
                        headers: new Headers(init?.headers as HeadersInit),
                        body: init?.body as string,
                    }),
                )
            }
            throw new Error(`unexpected fetch to ${url}`)
        },
    )
    vi.stubGlobal('fetch', impl)
    return impl
}

/** The authorize call the shipped Safari popup makes, returning the signed
 * state it would carry into the provider. */
async function authorizeWithNonce(nonce: string | null) {
    const params = new URLSearchParams({
        provider: 'google',
        redirect_uri: SAFARI_REDIRECT_URI,
    })
    if (nonce !== null) params.set('nonce', nonce)
    const res = await authorizeGET(
        new NextRequest(
            `${BASE}/api/extension/oauth/authorize?${params.toString()}`,
            { headers: { origin: KNOWN_ORIGIN } },
        ),
    )
    return {
        res,
        body: (await res.json()) as { state?: string; error?: string },
    }
}

const statePayload = (signedState: string) =>
    JSON.parse(
        Buffer.from(signedState.split('.')[0], 'base64url').toString(),
    ) as Record<string, unknown>

const poll = (nonce: string | null) =>
    pollGET(
        new NextRequest(
            nonce === null
                ? `${BASE}/api/extension/oauth/poll`
                : `${BASE}/api/extension/oauth/poll?nonce=${encodeURIComponent(nonce)}`,
            { headers: { origin: KNOWN_ORIGIN } },
        ),
    )

/** The provider callback that lands on /redirect after the user consents. */
const redirectCallback = (params: Record<string, string>) =>
    redirectGET(
        new NextRequest(
            `${BASE}/api/extension/oauth/redirect?${new URLSearchParams(params).toString()}`,
        ),
    )

beforeEach(() => {
    resetNonceStoreForTests()
    vi.clearAllMocks()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('authorize accepts the shipped Safari nonce', () => {
    it('embeds the nonce in the signed state so it survives the provider round trip', async () => {
        const { res, body } = await authorizeWithNonce(NONCE)
        expect(res.status).toBe(200)
        expect(statePayload(body.state!).nonce).toBe(NONCE)
    })

    it('leaves the Chrome/Firefox state byte-identical when no nonce is sent', async () => {
        // The whole safety case for touching authorize: a nonce-less call must
        // produce the exact payload it produced before the shim existed.
        const { body } = await authorizeWithNonce(null)
        const payload = statePayload(body.state!)
        expect(Object.keys(payload)).toEqual(['provider', 'redirectUri', 'iat'])
        expect('nonce' in payload).toBe(false)
    })

    it('refuses a nonce /poll could never look up, instead of signing a dead state', async () => {
        // Silently accepting it would make the popup poll a nonce that cannot
        // exist for its full 5 minutes and then report a timeout.
        const { res, body } = await authorizeWithNonce('too-short')
        expect(res.status).toBe(400)
        expect(body.error).toBe('Invalid nonce parameter')
    })
})

describe('poll — the contract the shipped popup implements', () => {
    it('400s with the published message when the nonce is missing', async () => {
        const res = await poll(null)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(
            'Missing or invalid nonce',
        )
    })

    it('400s on a malformed nonce rather than treating it as pending', async () => {
        expect((await poll('short')).status).toBe(400)
        expect((await poll('x'.repeat(129))).status).toBe(400)
    })

    it('204s with an empty body for a nonce nobody has completed yet', async () => {
        // 204 is what keeps the popup polling; any other code stops it.
        const res = await poll(NONCE)
        expect(res.status).toBe(204)
        expect(await res.text()).toBe('')
    })

    it('reflects CORS back to a known extension origin', async () => {
        const res = await poll(NONCE)
        expect(res.headers.get('access-control-allow-origin')).toBe(
            KNOWN_ORIGIN,
        )
    })
})

describe('the full shipped Safari sign-in, end to end', () => {
    it('hands the popup a real minted session token exactly once', async () => {
        const fetchImpl = installFetchImpl()

        // 1. popup -> authorize, carrying its nonce
        const { body } = await authorizeWithNonce(NONCE)
        const state = body.state!

        // 2. while the user is at Google, the popup is polling
        expect((await poll(NONCE)).status).toBe(204)

        // 3. Google sends the user back to OUR redirect (not to the extension)
        const cb = await redirectCallback({ code: 'FAKE_CODE', state })
        expect(cb.status).toBe(200)
        expect(cb.headers.get('content-type')).toContain('text/html')
        expect(await cb.text()).toContain("You're signed in")
        // It must NOT try to bounce a Safari callback to an extension URL.
        expect(cb.headers.get('location')).toBeNull()

        // The exchange went through the app's own POST route, not a re-implementation.
        expect(
            fetchImpl.mock.calls.some(
                ([url]) => url === `${BASE}/api/extension/oauth`,
            ),
        ).toBe(true)

        // 4. the next poll returns the token the real mint produced
        const done = await poll(NONCE)
        expect(done.status).toBe(200)
        expect(await done.json()).toEqual({
            token: EXPECTED_SESSION_TOKEN,
            username: 'Safari Shim',
            image: 'https://example.com/avatar.png',
        })
        expect(prismaMock.session.create).toHaveBeenCalledTimes(1)

        // 5. one-shot: a replayed poll cannot redeem the same token again
        expect((await poll(NONCE)).status).toBe(204)
    })

    it('forwards the user IP so the exchange is rate-limited per user, not globally', async () => {
        // Without this the loopback POST looks header-less and every Safari
        // sign-in in the world shares one per-IP bucket.
        const fetchImpl = installFetchImpl()
        const { body } = await authorizeWithNonce(NONCE)
        await redirectGET(
            new NextRequest(
                `${BASE}/api/extension/oauth/redirect?code=FAKE_CODE&state=${encodeURIComponent(body.state!)}`,
                { headers: { 'x-real-ip': '203.0.113.9' } },
            ),
        )
        const call = fetchImpl.mock.calls.find(
            ([url]) => url === `${BASE}/api/extension/oauth`,
        )
        const headers = new Headers(call![1]!.headers as HeadersInit)
        expect(headers.get('x-real-ip')).toBe('203.0.113.9')
    })

    it('stops the popup polling when the provider refuses', async () => {
        // Without a stored sentinel the user waits out the full 5-minute TTL
        // and is told "timed out" instead of "sign-in failed".
        const { body } = await authorizeWithNonce(NONCE)
        const cb = await redirectCallback({
            error: 'access_denied',
            state: body.state!,
        })
        expect(cb.status).toBe(400)
        // The provider's text is never echoed into the HTML page.
        expect(await cb.text()).not.toContain('access_denied')

        const res = await poll(NONCE)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(
            'OAuth sign-in failed',
        )
    })

    it('stops the popup polling when the exchange itself fails', async () => {
        installFetchImpl({ googleEmailVerified: false }) // real POST answers 403
        const { body } = await authorizeWithNonce(NONCE)
        const cb = await redirectCallback({
            code: 'FAKE_CODE',
            state: body.state!,
        })
        expect(cb.status).toBe(400)
        expect(prismaMock.session.create).not.toHaveBeenCalled()

        const res = await poll(NONCE)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(
            'OAuth sign-in failed',
        )
    })

    it('expires a completed-but-uncollected result at the 5 minutes the client waits', async () => {
        installFetchImpl()
        const { body } = await authorizeWithNonce(NONCE)
        await redirectCallback({ code: 'FAKE_CODE', state: body.state! })

        vi.useFakeTimers()
        vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1)

        // Back to "pending" rather than handing out a stale session token —
        // and the client has stopped polling by now anyway (popup.js:126).
        expect((await poll(NONCE)).status).toBe(204)
    })
})

describe('the Chrome/Firefox redirect path is untouched', () => {
    it('still 302s a nonce-less callback to the extension redirect URI', async () => {
        const res = await redirectCallback({
            extension_redirect: CHROME_REDIRECT_URI,
            code: 'FAKE_CODE',
            state: 'signed-state-without-nonce',
        })
        expect(res.status).toBeGreaterThanOrEqual(300)
        expect(res.status).toBeLessThan(400)
        const loc = new URL(res.headers.get('location')!)
        expect(loc.origin + loc.pathname).toBe(CHROME_REDIRECT_URI)
        expect(loc.searchParams.get('code')).toBe('FAKE_CODE')
    })

    it('still applies the origin guard to a hostile destination', async () => {
        const res = await redirectCallback({
            extension_redirect: 'https://evil.example.com/',
            code: 'FAKE_CODE',
            state: 's',
        })
        expect(res.status).toBe(400)
    })

    it("still unwraps Apple's form_post envelope and forwards the inner state", async () => {
        const form = new FormData()
        form.append('code', 'FAKE_CODE')
        form.append(
            'state',
            Buffer.from(
                JSON.stringify({
                    r: CHROME_REDIRECT_URI,
                    s: 'the-signed-state',
                }),
            ).toString('base64'),
        )
        const res = await redirectPOST(
            new NextRequest(`${BASE}/api/extension/oauth/redirect`, {
                method: 'POST',
                body: form,
            }),
        )
        const loc = new URL(res.headers.get('location')!)
        expect(loc.origin + loc.pathname).toBe(CHROME_REDIRECT_URI)
        expect(loc.searchParams.get('state')).toBe('the-signed-state')
    })
})
