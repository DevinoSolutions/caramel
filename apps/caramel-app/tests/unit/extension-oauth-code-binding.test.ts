import { GET as redirectGET } from '@/app/api/extension/oauth/redirect/route'
import { POST as oauthPOST } from '@/app/api/extension/oauth/route'
import {
    bindCodeToState,
    codeBoundToState,
    isBoundCode,
} from '@/lib/auth/extensionOAuthCodeBinding'
import { NATIVE_APP_REDIRECT_URI } from '@/lib/auth/extensionOAuthRedirect'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest } from 'next/server'
import { createHash, createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-21 (T-5449), H1, H2 and M2.
//
// H1: every code that comes back through our /redirect hop is exchanged under
// the SAME provider redirect_uri, so the provider cannot tell one hop flow
// from another, and nothing tied a code to the state it was issued with. A
// code lifted from the app's callback could be traded under another state
// naming the hop, which carries no PKCE challenge, and the app's verifier was
// never asked for. The hop now binds each code to its state, and the exchange
// redeems a hop code only under that state.
//
// H2 / M2: the hop's Safari branch (removed 2026-11-10, T-4318) completed the
// exchange itself and parked the session under a caller-chosen nonce for
// /poll. The branch and /poll are gone: a state naming the hop is forwarded
// nowhere, and every hop request is rate-limited.

const { envMock, OAUTH_STATE_SECRET } = vi.hoisted(() => {
    const OAUTH_STATE_SECRET = 'test-oauth-state-secret-code-binding'
    return {
        OAUTH_STATE_SECRET,
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: OAUTH_STATE_SECRET as string,
            GOOGLE_CLIENT_ID: 'test-google-client-id' as string | undefined,
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret' as
                string | undefined,
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
        username: 'u',
        image: null,
    })),
    ExtensionOAuthEmailRequiredError: class extends Error {},
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setUser: vi.fn(),
    withScope: vi.fn(),
}))

const BASE = 'https://grabcaramel.test'
const HOP = `${BASE}/api/extension/oauth/redirect`
const APP = NATIVE_APP_REDIRECT_URI
const EXT = 'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/'
const VERIFIER = 'a'.repeat(20) + 'B'.repeat(20) + '-._~0123456789'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const NONCE = '11111111-2222-3333-4444-555555555555'
// The shipped Safari 1.4.11 build's state shape: our own hop as redirectUri,
// plus a nonce. Authorize no longer signs it; the pins below sign it by hand.
const SAFARI_SHAPE = { provider: 'google', redirectUri: HOP, nonce: NONCE }

function sign(payload: Record<string, unknown>, secret = OAUTH_STATE_SECRET) {
    const data = JSON.stringify({ ...payload, iat: Date.now() })
    const sig = createHmac('sha256', secret).update(data).digest('base64url')
    return `${Buffer.from(data).toString('base64url')}.${sig}`
}

const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input)
        const body = url.includes('oauth2.googleapis.com/token')
            ? { access_token: 'at', id_token: 'it' }
            : url.includes('appleid.apple.com/auth/token')
              ? {
                    access_token: 'at',
                    id_token: `h.${Buffer.from(
                        JSON.stringify({
                            sub: 'apple-sub',
                            email: 'a@example.com',
                            email_verified: true,
                        }),
                    ).toString('base64url')}.s`,
                }
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
    vi.mocked(checkRateLimit).mockClear()
})

const exchange = (body: Record<string, unknown>) =>
    oauthPOST(
        new NextRequest(`${BASE}/api/extension/oauth`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    )

const providerTokenCalls = () =>
    fetchMock.mock.calls.filter(([u]) =>
        /oauth2\.googleapis\.com\/token|appleid\.apple\.com\/auth\/token/.test(
            String(u),
        ),
    )

describe('a code is redeemable only under the state it came back with (H1)', () => {
    it("THE ATTACK: the app's code under another hop state is refused before any provider call", async () => {
        // What a hostile app on the device holds after intercepting the
        // callback: the hop-bound code and the app's state (with its PKCE
        // challenge, which it cannot satisfy), plus some other hop state.
        const appState = sign({
            provider: 'google',
            redirectUri: APP,
            codeChallenge: CHALLENGE,
        })
        const interceptedCode = bindCodeToState('GOOGLE_CODE', appState)
        const shimState = sign(SAFARI_SHAPE)

        const res = await exchange({
            provider: 'google',
            code: interceptedCode,
            state: shimState,
            redirectUri: HOP,
        })

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Authorization code does not belong to this sign-in',
        })
        expect(providerTokenCalls()).toHaveLength(0)
    })

    it('and the RAW code under that hop state is refused too (the hop never forwards one)', async () => {
        const shimState = sign(SAFARI_SHAPE)
        const res = await exchange({
            provider: 'google',
            code: 'GOOGLE_CODE',
            state: shimState,
            redirectUri: HOP,
        })
        expect(res.status).toBe(400)
        expect(providerTokenCalls()).toHaveLength(0)
    })

    it('an Apple code bound to one sign-in is refused under another Apple state', async () => {
        const victimState = sign({ provider: 'apple', redirectUri: APP })
        const attackerState = sign({ provider: 'apple', redirectUri: EXT })
        const res = await exchange({
            provider: 'apple',
            code: bindCodeToState('APPLE_CODE', victimState),
            state: attackerState,
            redirectUri: EXT,
        })
        expect(res.status).toBe(400)
        expect(providerTokenCalls()).toHaveLength(0)
    })

    it('an Apple code under its OWN state is exchanged, and Apple gets the raw code', async () => {
        const state = sign({ provider: 'apple', redirectUri: EXT })
        const res = await exchange({
            provider: 'apple',
            code: bindCodeToState('APPLE_CODE', state),
            state,
            redirectUri: EXT,
        })
        expect(res.status).toBe(200)
        const [call] = providerTokenCalls()
        const sent = new URLSearchParams(String(call?.[1]?.body))
        expect(sent.get('code')).toBe('APPLE_CODE')
    })

    it("the app's code under its own state still needs the verifier, and then works", async () => {
        const state = sign({
            provider: 'google',
            redirectUri: APP,
            codeChallenge: CHALLENGE,
        })
        const code = bindCodeToState('GOOGLE_CODE', state)
        const without = await exchange({
            provider: 'google',
            code,
            state,
            redirectUri: APP,
        })
        expect(without.status).toBe(400)

        const withVerifier = await exchange({
            provider: 'google',
            code,
            state,
            redirectUri: APP,
            codeVerifier: VERIFIER,
        })
        expect(withVerifier.status).toBe(200)
        const [call] = providerTokenCalls()
        const sent = new URLSearchParams(String(call?.[1]?.body))
        expect(sent.get('code')).toBe('GOOGLE_CODE')
        expect(sent.get('redirect_uri')).toBe(HOP)
    })

    it("an extension's Google code (straight from Google, never via the hop) is exchanged as-is", async () => {
        const state = sign({ provider: 'google', redirectUri: EXT })
        const res = await exchange({
            provider: 'google',
            code: 'GOOGLE_CODE',
            state,
            redirectUri: EXT,
        })
        expect(res.status).toBe(200)
    })

    it('a hop-bound code is refused on a flow that never goes through the hop', async () => {
        const state = sign({ provider: 'google', redirectUri: EXT })
        const res = await exchange({
            provider: 'google',
            code: bindCodeToState('GOOGLE_CODE', state),
            state,
            redirectUri: EXT,
        })
        expect(res.status).toBe(400)
        expect(providerTokenCalls()).toHaveLength(0)
    })
})

describe('the binding itself', () => {
    it('round-trips any provider code, dots included (Apple codes carry dots)', () => {
        for (const code of ['c0ffee.0.abcd', 'x', '4/0AY0e-g7_-.~']) {
            expect(codeBoundToState(bindCodeToState(code, 'st'), 'st')).toBe(
                code,
            )
        }
    })

    it('refuses another state, a tampered MAC and a tampered code', () => {
        const bound = bindCodeToState('CODE', 'st')
        expect(codeBoundToState(bound, 'other')).toBeNull()
        const [p, c, m] = bound.split('.')
        expect(
            codeBoundToState(`${p}.${c}.${m.slice(0, -1)}A`, 'st'),
        ).toBeNull()
        const forged = Buffer.from('OTHER').toString('base64url')
        expect(codeBoundToState(`${p}.${forged}.${m}`, 'st')).toBeNull()
        expect(codeBoundToState('CODE', 'st')).toBeNull()
    })

    it('is URL-safe, so it survives the query string unchanged', () => {
        const bound = bindCodeToState('a.b/c+d=e', 'st')
        expect(isBoundCode(bound)).toBe(true)
        expect(encodeURIComponent(bound)).toBe(bound)
    })
})

describe('the Safari poll branch is gone (H2) and the hop is throttled (M2)', () => {
    const hop = (params: Record<string, string>) =>
        redirectGET(new NextRequest(`${HOP}?${new URLSearchParams(params)}`))

    it('a genuinely signed Safari-shaped state runs no exchange and mints nothing', async () => {
        const res = await hop({
            code: 'GOOGLE_CODE',
            state: sign(SAFARI_SHAPE),
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Missing extension redirect URI',
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a Safari-shaped error callback is answered as JSON, with no page and no exchange', async () => {
        const res = await hop({
            error: 'access_denied',
            state: sign(SAFARI_SHAPE),
        })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('every hop request goes through the per-IP mutation limit', async () => {
        await hop({ code: 'C', state: 's', extension_redirect: EXT })
        expect(checkRateLimit).toHaveBeenCalledWith(
            expect.anything(),
            'mutation',
        )
    })
})
