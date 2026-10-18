import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import { POST as oauthPOST } from '@/app/api/extension/oauth/route'
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two HTTP hops that carry an extension's install id + first-touch record
// to the signup: POST /api/extension/oauth (Chrome/Edge/Firefox put the fields
// in the body) and GET /api/extension/oauth/authorize (Safari's exchange runs
// server-side, so they ride the signed state). Doubles, all announced:
//   - env / rate limit / better-auth graph / Apple secret: same stand-ins as
//     route-pipeline.test.ts (module-top-level env snapshot, see its NOTE);
//   - mintExtensionSession: its own behaviour is pinned in
//     extensionOAuthSession.test.ts; here it only records what it was given;
//   - global fetch: Google's token + userinfo endpoints;
//   - Sentry: records the warnings an invalid field must raise.

const { envMock, OAUTH_STATE_SECRET, KNOWN_ORIGIN } = vi.hoisted(() => {
    const OAUTH_STATE_SECRET = 'test-oauth-state-secret-attribution'
    const KNOWN_ORIGIN = 'chrome-extension://known-extension-id-attribution'
    return {
        OAUTH_STATE_SECRET,
        KNOWN_ORIGIN,
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: OAUTH_STATE_SECRET as string,
            GOOGLE_CLIENT_ID: 'test-google-client-id' as string | undefined,
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret' as
                | string
                | undefined,
            APPLE_CLIENT_ID: undefined as string | undefined,
            BETTER_AUTH_URL: 'http://localhost:58000',
            CHROME_EXTENSION_ORIGIN: KNOWN_ORIGIN as string | undefined,
            FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
            SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
            COUPONS_ADMIN_SECRET: undefined as string | undefined,
        },
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))
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

const { mintMock } = vi.hoisted(() => ({
    mintMock: vi.fn(async () => ({
        token: 'session-token',
        username: 'Google User',
        image: null,
    })),
}))
vi.mock('@/lib/auth/extensionOAuthSession', () => ({
    mintExtensionSession: mintMock,
    ExtensionOAuthEmailRequiredError: class extends Error {},
}))

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: {
        captureMessage: vi.fn(),
        captureException: vi.fn(),
        addBreadcrumb: vi.fn(),
        withScope: vi.fn(),
        setTag: vi.fn(),
        setContext: vi.fn(),
    },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

const REDIRECT_URI = 'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/'
const IID = '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01'
const OTHER_IID = '9a1c7e22-84d3-4f0b-8b66-2e5d7f3a1c90'
const record = {
    utm_source: 'reddit',
    referrer_domain: 'reddit.com',
    landing_path: '/',
    captured_at: '2026-10-01T12:00:00.000Z',
}

function signState(extra: Record<string, unknown> = {}): string {
    const data = JSON.stringify({
        provider: 'google',
        redirectUri: REDIRECT_URI,
        iat: Date.now(),
        ...extra,
    })
    const sig = createHmac('sha256', OAUTH_STATE_SECRET)
        .update(data)
        .digest('base64url')
    return `${Buffer.from(data).toString('base64url')}.${sig}`
}

function decodeState(state: string): Record<string, unknown> {
    return JSON.parse(
        Buffer.from(state.split('.')[0]!, 'base64url').toString(),
    ) as Record<string, unknown>
}

function exchange(extraBody: Record<string, unknown>, state = signState()) {
    return oauthPOST(
        new NextRequest('http://localhost/api/extension/oauth', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: KNOWN_ORIGIN,
            },
            body: JSON.stringify({
                provider: 'google',
                code: 'auth-code',
                state,
                redirectUri: REDIRECT_URI,
                ...extraBody,
            }),
        }),
    )
}

function lastMintAttribution() {
    const calls = mintMock.mock.calls as unknown as [{ attribution: unknown }][]
    return calls[calls.length - 1]![0].attribution
}

beforeEach(() => {
    mintMock.mockClear()
    for (const fn of Object.values(sentryMock)) fn.mockReset()
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            const body = url.includes('oauth2.googleapis.com/token')
                ? { access_token: 'at', id_token: 'it' }
                : {
                      id: 'google-user-id',
                      email: 'googleuser@example.com',
                      name: 'Google User',
                      picture: null,
                      verified_email: true,
                  }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }),
    )
})

describe('POST /api/extension/oauth: optional iid + firstTouch', () => {
    it('valid fields reach the mint', async () => {
        const res = await exchange({ iid: IID, firstTouch: record })
        expect(res.status).toBe(200)
        expect(lastMintAttribution()).toEqual({
            installId: IID,
            firstTouch: record,
        })
        expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('an old build (neither field) still signs in, with no attribution', async () => {
        const res = await exchange({})
        expect(res.status).toBe(200)
        expect(lastMintAttribution()).toEqual({
            installId: null,
            firstTouch: null,
        })
        expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('invalid fields are dropped with a Sentry warning and NEVER a 4xx', async () => {
        const res = await exchange({
            iid: 'not-an-install-id',
            firstTouch: { utm_source: 'reddit' },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            token: 'session-token',
            username: 'Google User',
            image: null,
        })
        expect(lastMintAttribution()).toEqual({
            installId: null,
            firstTouch: null,
        })
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(2)
        for (const call of sentryMock.captureMessage.mock.calls) {
            expect(call[1]).toMatchObject({ level: 'warning' })
        }
    })

    it('wrong-typed fields (objects where a string belongs) are dropped, not a 422', async () => {
        const res = await exchange({ iid: { nested: true }, firstTouch: 7 })
        expect(res.status).toBe(200)
        expect(lastMintAttribution()).toEqual({
            installId: null,
            firstTouch: null,
        })
    })

    it('falls back to the attribution signed into the state (the Safari flow) when the body has none', async () => {
        const res = await exchange(
            {},
            signState({ attribution: { iid: IID, firstTouch: record } }),
        )
        expect(res.status).toBe(200)
        expect(lastMintAttribution()).toEqual({
            installId: IID,
            firstTouch: record,
        })
    })

    it('an oversize firstTouch in the POST body is dropped, iid kept', async () => {
        const big = 'x'.repeat(255)
        const res = await exchange({
            iid: IID,
            firstTouch: {
                ...record,
                utm_campaign: big,
                ref: big,
                gclid: big,
                fbclid: big,
                referrer_domain: big,
            },
        })
        expect(res.status).toBe(200)
        expect(lastMintAttribution()).toEqual({
            installId: IID,
            firstTouch: null,
        })
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
    })

    it('the body wins over the state, field by field', async () => {
        await exchange(
            { iid: OTHER_IID },
            signState({ attribution: { iid: IID, firstTouch: record } }),
        )
        expect(lastMintAttribution()).toEqual({
            installId: OTHER_IID,
            firstTouch: record,
        })
    })
})

describe('GET /api/extension/oauth/authorize: attribution for the Safari flow', () => {
    function authorize(params: Record<string, string>) {
        const url = new URL('http://localhost/api/extension/oauth/authorize')
        const all = {
            provider: 'google',
            redirect_uri: REDIRECT_URI,
            ...params,
        }
        for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v)
        return authorizeGET(
            new NextRequest(url, { headers: { origin: KNOWN_ORIGIN } }),
        )
    }

    it('signs iid + ft into the state', async () => {
        const res = await authorize({ iid: IID, ft: JSON.stringify(record) })
        expect(res.status).toBe(200)
        const { state } = (await res.json()) as { state: string }
        expect(decodeState(state).attribution).toEqual({
            iid: IID,
            firstTouch: record,
        })
    })

    it('strips utm_term/utm_content and truncates landing_path in the state', async () => {
        const res = await authorize({
            iid: IID,
            ft: JSON.stringify({
                ...record,
                utm_term: 'honey alternative',
                utm_content: 'banner-a',
                landing_path: `/${'p'.repeat(250)}`,
            }),
        })
        const { state } = (await res.json()) as { state: string }
        const attribution = decodeState(state).attribution as {
            firstTouch: Record<string, string>
        }
        expect(attribution.firstTouch).not.toHaveProperty('utm_term')
        expect(attribution.firstTouch).not.toHaveProperty('utm_content')
        expect(attribution.firstTouch.landing_path).toHaveLength(200)
        expect(attribution.firstTouch.utm_source).toBe('reddit')
    })

    it('an oversize record is dropped from the state, iid is kept, one warning (length only)', async () => {
        const big = 'x'.repeat(255)
        const res = await authorize({
            iid: IID,
            ft: JSON.stringify({
                ...record,
                utm_campaign: big,
                ref: big,
                gclid: big,
                fbclid: big,
                referrer_domain: big,
                landing_path: big,
            }),
        })
        expect(res.status).toBe(200)
        const { state } = (await res.json()) as { state: string }
        expect(decodeState(state).attribution).toEqual({ iid: IID })
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
        const [, options] = sentryMock.captureMessage.mock.calls[0]!
        expect(options).toMatchObject({
            level: 'warning',
            extra: { field: 'firstTouch' },
        })
        expect(JSON.stringify(options)).not.toContain('xxxx')
    })

    it('without them the state has no attribution key at all (byte-identical to before)', async () => {
        const res = await authorize({})
        const { state } = (await res.json()) as { state: string }
        expect(decodeState(state)).not.toHaveProperty('attribution')
    })

    it('invalid values are dropped with a warning; the authorize call still succeeds', async () => {
        const res = await authorize({ iid: 'nope', ft: '{broken' })
        expect(res.status).toBe(200)
        const { state } = (await res.json()) as { state: string }
        expect(decodeState(state)).not.toHaveProperty('attribution')
        expect(sentryMock.captureMessage).toHaveBeenCalledTimes(2)
    })
})
