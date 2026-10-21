import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import { GET as redirectGET } from '@/app/api/extension/oauth/redirect/route'
import { POST as oauthPOST } from '@/app/api/extension/oauth/route'
import {
    bindCodeToState,
    codeBoundToState,
} from '@/lib/auth/extensionOAuthCodeBinding'
import {
    isAllowedExtensionRedirectUri,
    NATIVE_APP_REDIRECT_URI,
} from '@/lib/auth/extensionOAuthRedirect'
import { NextRequest } from 'next/server'
import { createHash, createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The native iOS app's OAuth redirect target (T-4906): the app opens
// /authorize in an ASWebAuthenticationSession whose callbackURLScheme is the
// app's scheme, and the sheet closes when the flow lands on that scheme.
//
//   Google: provider -> /oauth/redirect (the registered URI) -> 303 to the app
//   Apple:  provider -> /oauth/redirect (form_post, the {r,s} envelope) -> 303
//           to the app
//   then the app POSTs the code to /api/extension/oauth like every client.
//
// Each block also pins that the EXTENSION behaviour did not move (the same
// calls with an extension redirect URI answer exactly as before). Doubles are
// the same stand-ins as extension-oauth-attribution-route.test.ts: env, rate
// limit, better-auth, Apple secret, mintExtensionSession (pinned on its own in
// extensionOAuthSession.test.ts), global fetch for Google's endpoints, Sentry.

const { envMock, OAUTH_STATE_SECRET } = vi.hoisted(() => {
    const OAUTH_STATE_SECRET = 'test-oauth-state-secret-app-redirect'
    return {
        OAUTH_STATE_SECRET,
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: OAUTH_STATE_SECRET as string,
            GOOGLE_CLIENT_ID: 'test-google-client-id' as string | undefined,
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret' as
                | string
                | undefined,
            APPLE_CLIENT_ID: 'test.apple.client' as string | undefined,
            BETTER_AUTH_URL: 'https://grabcaramel.test',
            CHROME_EXTENSION_ORIGIN: undefined as string | undefined,
            FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
            SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
            COUPONS_ADMIN_SECRET: undefined as string | undefined,
        },
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://grabcaramel.test' }))
vi.mock('@/lib/auth/appleClientSecret', () => ({
    getAppleClientSecret: vi.fn(() => 'mock-apple-secret'),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: vi.fn(async () => null) } },
}))
vi.mock('@/lib/auth/extensionOAuthSession', () => ({
    mintExtensionSession: vi.fn(async () => ({
        token: 'session-token',
        username: 'Google User',
        image: null,
    })),
    ExtensionOAuthEmailRequiredError: class extends Error {},
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
}))

// A real PKCE pair, as the app derives it: base64url(SHA-256(verifier)).
const VERIFIER = 'a'.repeat(20) + 'B'.repeat(20) + '-._~0123456789'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const OTHER_VERIFIER = 'z'.repeat(50)

const APP = NATIVE_APP_REDIRECT_URI
const EXT = 'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/'
const BASE = 'https://grabcaramel.test'
const INTERMEDIATE = `${BASE}/api/extension/oauth/redirect`

function authorize(params: Record<string, string>) {
    return authorizeGET(
        new NextRequest(
            `${BASE}/api/extension/oauth/authorize?${new URLSearchParams(params)}`,
        ),
    )
}

function redirect(params: Record<string, string>) {
    return redirectGET(
        new NextRequest(
            `${INTERMEDIATE}?${new URLSearchParams(params).toString()}`,
        ),
    )
}

function signState(
    redirectUri: string,
    provider = 'google',
    codeChallenge?: string,
): string {
    const data = JSON.stringify({
        provider,
        redirectUri,
        ...(codeChallenge ? { codeChallenge } : {}),
        iat: Date.now(),
    })
    const sig = createHmac('sha256', OAUTH_STATE_SECRET)
        .update(data)
        .digest('base64url')
    return `${Buffer.from(data).toString('base64url')}.${sig}`
}

const envelope = (r: string, s: string) =>
    Buffer.from(JSON.stringify({ r, s })).toString('base64')

describe('isAllowedExtensionRedirectUri — the app redirect URI', () => {
    it('accepts exactly the app URI', () => {
        expect(isAllowedExtensionRedirectUri(APP)).toBe(true)
    })

    it.each([
        ['a different path', 'com.devino.caramel://auth/other'],
        ['a different host', 'com.devino.caramel://evil/callback'],
        ['a query string', `${APP}?x=1`],
        ['a trailing slash', `${APP}/`],
        ['another reverse-DNS scheme', 'com.evil.caramel://auth/callback'],
        ['an upper-cased scheme', 'COM.DEVINO.CARAMEL://auth/callback'],
        ['the old placeholder scheme', 'caramel-signin://auth/callback'],
        ['an https look-alike', 'https://com.devino.caramel/auth/callback'],
    ])('refuses %s', (_label, uri) => {
        expect(isAllowedExtensionRedirectUri(uri)).toBe(false)
    })

    it('still accepts a published extension and refuses a foreign one', () => {
        expect(isAllowedExtensionRedirectUri(EXT)).toBe(true)
        expect(
            isAllowedExtensionRedirectUri(
                'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
            ),
        ).toBe(false)
    })
})

describe('GET /api/extension/oauth/authorize — the app redirect URI', () => {
    it('sends Google to the registered /redirect hop, with the app URI in the signed state', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: APP,
            code_challenge: CHALLENGE,
        })
        expect(res.status).toBe(200)
        const { authorizationUrl, state } = (await res.json()) as {
            authorizationUrl: string
            state: string
        }
        const url = new URL(authorizationUrl)
        expect(url.origin + url.pathname).toBe(
            'https://accounts.google.com/o/oauth2/v2/auth',
        )
        // Google cannot be sent a custom scheme: it gets our own hop...
        expect(url.searchParams.get('redirect_uri')).toBe(INTERMEDIATE)
        expect(url.searchParams.get('state')).toBe(state)
        // ...and the app URI rides inside the signed state.
        const payload = JSON.parse(
            Buffer.from(state.split('.')[0]!, 'base64url').toString(),
        ) as { redirectUri: string; nonce?: string }
        expect(payload.redirectUri).toBe(APP)
        expect(payload.nonce).toBeUndefined()
        // PKCE: the challenge is signed into the state for the exchange.
        expect((payload as { codeChallenge?: string }).codeChallenge).toBe(
            CHALLENGE,
        )
    })

    it.each([
        ['absent', {}],
        ['too short', { code_challenge: 'abc' }],
        ['not base64url', { code_challenge: '+'.repeat(43) }],
        [
            'a plain (non-S256) method',
            { code_challenge: CHALLENGE, code_challenge_method: 'plain' },
        ],
    ])(
        'refuses the app URI when the code_challenge is %s',
        async (_l, extra) => {
            const res = await authorize({
                provider: 'google',
                redirect_uri: APP,
                ...extra,
            })
            expect(res.status).toBe(400)
        },
    )

    it('accepts an explicit S256 method', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: APP,
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
        })
        expect(res.status).toBe(200)
    })

    it('sends Apple to /redirect with the app URI in the {r,s} envelope', async () => {
        const res = await authorize({
            provider: 'apple',
            redirect_uri: APP,
            code_challenge: CHALLENGE,
        })
        expect(res.status).toBe(200)
        const { authorizationUrl } = (await res.json()) as {
            authorizationUrl: string
        }
        const url = new URL(authorizationUrl)
        expect(url.origin).toBe('https://appleid.apple.com')
        expect(url.searchParams.get('client_id')).toBe('test.apple.client')
        expect(url.searchParams.get('redirect_uri')).toBe(INTERMEDIATE)
        const inner = JSON.parse(
            Buffer.from(url.searchParams.get('state')!, 'base64').toString(),
        ) as { r: string }
        expect(inner.r).toBe(APP)
    })

    it('refuses a nonce together with the app URI', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: APP,
            code_challenge: CHALLENGE,
            nonce: '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01',
        })
        expect(res.status).toBe(400)
    })

    it('refuses a look-alike app URI', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: `${APP}?next=https://evil.example`,
            code_challenge: CHALLENGE,
        })
        expect(res.status).toBe(400)
    })

    it('leaves the extension flow alone: Google still gets the extension URI itself, and no challenge is demanded or signed', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: EXT,
            // Even if one is sent, an extension state never carries it.
            code_challenge: CHALLENGE,
        })
        const { authorizationUrl, state } = (await res.json()) as {
            authorizationUrl: string
            state: string
        }
        const payload = JSON.parse(
            Buffer.from(state.split('.')[0]!, 'base64url').toString(),
        ) as Record<string, unknown>
        expect(Object.keys(payload).sort()).toEqual([
            'iat',
            'provider',
            'redirectUri',
        ])
        expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
            EXT,
        )
    })
})

describe('GET /api/extension/oauth/redirect — bouncing to the app', () => {
    it("303s Google's callback to the app with the code and the signed state", async () => {
        const state = signState(APP)
        const res = await redirect({ code: 'GOOGLE_CODE', state })
        expect(res.status).toBe(303)
        const target = new URL(res.headers.get('location')!)
        expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(APP)
        expect(
            codeBoundToState(target.searchParams.get('code') ?? '', state),
        ).toBe('GOOGLE_CODE')
        expect(target.searchParams.get('state')).toBe(state)
    })

    it("303s Apple's callback (envelope) to the app with the inner state", async () => {
        const inner = signState(APP, 'apple')
        const res = await redirect({
            code: 'APPLE_CODE',
            state: envelope(APP, inner),
        })
        expect(res.status).toBe(303)
        const target = new URL(res.headers.get('location')!)
        expect(
            codeBoundToState(target.searchParams.get('code') ?? '', inner),
        ).toBe('APPLE_CODE')
        expect(target.searchParams.get('state')).toBe(inner)
    })

    it("hands the provider's error back to the app too", async () => {
        const state = signState(APP)
        const res = await redirect({ error: 'access_denied', state })
        expect(res.status).toBe(303)
        const target = new URL(res.headers.get('location')!)
        expect(target.searchParams.get('error')).toBe('access_denied')
        expect(target.searchParams.get('state')).toBe(state)
    })

    it('does not take a destination from the signed state unless it is the app URI', async () => {
        const res = await redirect({
            code: 'C',
            state: signState('https://evil.example.com/'),
        })
        // Exactly the pre-existing answer for a callback with no destination.
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Missing extension redirect URI',
        })
    })

    it('still forwards to an extension with the default 307', async () => {
        const res = await redirect({
            code: 'C',
            state: 'plain-state',
            extension_redirect: EXT,
        })
        expect(res.status).toBe(307)
        expect(res.headers.get('location')).toBe(
            `${EXT}?code=${bindCodeToState('C', 'plain-state')}&state=plain-state`,
        )
    })
})

describe('POST /api/extension/oauth — exchanging the app flow', () => {
    const fetchMock = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input)
            const body = url.includes('oauth2.googleapis.com/token')
                ? { access_token: 'at', id_token: 'it' }
                : {
                      id: 'google-user-id',
                      email: 'googleuser@example.com',
                      verified_email: true,
                  }
            return new Response(JSON.stringify(body), { status: 200 })
        },
    )

    beforeEach(() => {
        fetchMock.mockClear()
        vi.stubGlobal('fetch', fetchMock)
    })

    const exchange = (
        redirectUri: string,
        state: string,
        codeVerifier?: string,
    ) =>
        oauthPOST(
            new NextRequest(`${BASE}/api/extension/oauth`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    provider: 'google',
                    // The app's code reaches it through our /redirect hop,
                    // which binds it to the state it came back with; an
                    // extension's comes straight from Google, unbound.
                    code:
                        redirectUri === APP
                            ? bindCodeToState('auth-code', state)
                            : 'auth-code',
                    state,
                    redirectUri,
                    ...(codeVerifier ? { codeVerifier } : {}),
                }),
            }),
        )

    const tokenRedirectUri = (): string | null => {
        const call = fetchMock.mock.calls.find(([input]) =>
            String(input).includes('oauth2.googleapis.com/token'),
        )
        const init = call?.[1]
        return new URLSearchParams(String(init?.body)).get('redirect_uri')
    }

    it("quotes the /redirect hop to Google's token endpoint for the app URI, the value /authorize used", async () => {
        const res = await exchange(
            APP,
            signState(APP, 'google', CHALLENGE),
            VERIFIER,
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ token: 'session-token' })
        expect(tokenRedirectUri()).toBe(INTERMEDIATE)
    })

    it('still quotes the extension URI itself for an extension, with no verifier', async () => {
        const res = await exchange(EXT, signState(EXT))
        expect(res.status).toBe(200)
        expect(tokenRedirectUri()).toBe(EXT)
    })

    it('ignores a verifier sent by an extension', async () => {
        const res = await exchange(EXT, signState(EXT), OTHER_VERIFIER)
        expect(res.status).toBe(200)
    })

    it.each([
        ['no verifier', undefined],
        ['a verifier that does not match the challenge', OTHER_VERIFIER],
        ['a malformed (too short) verifier', 'short'],
    ])(
        'refuses the app exchange with %s, before any provider call',
        async (_l, verifier) => {
            const res = await exchange(
                APP,
                signState(APP, 'google', CHALLENGE),
                verifier,
            )
            expect(res.status).toBe(400)
            expect(await res.json()).toEqual({
                error: 'Invalid or missing code_verifier',
            })
            expect(fetchMock).not.toHaveBeenCalled()
        },
    )

    it('refuses an app exchange whose state carries no challenge (a state we would never have issued)', async () => {
        const res = await exchange(APP, signState(APP), VERIFIER)
        expect(res.status).toBe(400)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects an app exchange whose state was signed for another redirect URI', async () => {
        const res = await exchange(APP, signState(EXT))
        expect(res.status).toBe(400)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
