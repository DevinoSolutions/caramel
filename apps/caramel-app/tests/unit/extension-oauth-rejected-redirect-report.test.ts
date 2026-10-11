import { GET as authorizeGET } from '@/app/api/extension/oauth/authorize/route'
import {
    GET as redirectGET,
    POST as redirectPOST,
} from '@/app/api/extension/oauth/redirect/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Repo rule: no silent failures. A refused extension redirect is either an
// attack on the code-forwarding hop or our own allowlist going stale (a new
// store build), and a bare 400 shows neither. Both routes must send a Sentry
// warning carrying route + provider and ONLY the rejected URI's host: the full
// URL (code, state, token, path, userinfo) must never leave the process.

const { envMock, BASE, captureMessageMock } = vi.hoisted(() => {
    const BASE = 'https://localhost:58000'
    return {
        BASE,
        captureMessageMock: vi.fn(),
        envMock: {
            EXTENSION_OAUTH_STATE_SECRET: 'test-oauth-state-secret-report',
            GOOGLE_CLIENT_ID: 'test-google-client-id',
            APPLE_CLIENT_ID: 'test-apple-client-id',
            BETTER_AUTH_URL: BASE,
            CHROME_EXTENSION_ORIGIN: undefined as string | undefined,
            FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
            SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
            COUPONS_ADMIN_SECRET: undefined as string | undefined,
        },
    }
})
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: BASE }))
vi.mock('@sentry/nextjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@sentry/nextjs')>()
    return { ...actual, captureMessage: captureMessageMock }
})
// authorize is rate-limited per IP; its own limiter is pinned in
// rateLimit.test.ts and is out of scope here.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const CHROME_REDIRECT =
    'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/'
const SECRETS = ['SECRET-CODE', 'SECRET-TOKEN', 'SECRET-STATE', 'hunter2']
// Host evil.example; everything else here must never be reported.
const FOREIGN_URI =
    'https://user:hunter2@evil.example:8443/steal/path?code=SECRET-CODE&token=SECRET-TOKEN#frag'

/** What the Apple leg's signed state looks like to /redirect: base64url JSON
 * payload + '.' + a signature the redirect hop does not verify. */
const signedState = (provider: 'google' | 'apple') =>
    `${Buffer.from(JSON.stringify({ provider, redirectUri: FOREIGN_URI })).toString('base64url')}.sig-SECRET-STATE`
const envelope = (redirect: string, inner: string) =>
    Buffer.from(JSON.stringify({ r: redirect, s: inner })).toString('base64')

const authorize = (params: Record<string, string>) =>
    authorizeGET(
        new NextRequest(
            `${BASE}/api/extension/oauth/authorize?${new URLSearchParams(params).toString()}`,
        ),
    )
const redirect = (params: Record<string, string>) =>
    redirectGET(
        new NextRequest(
            `${BASE}/api/extension/oauth/redirect?${new URLSearchParams(params).toString()}`,
        ),
    )

function expectOneWarning(route: string, provider: string, host: string) {
    expect(captureMessageMock).toHaveBeenCalledTimes(1)
    const [message, options] = captureMessageMock.mock.calls[0]
    expect(options).toEqual({
        level: 'warning',
        tags: { route, provider },
        extra: { rejectedHost: host },
    })
    // Nothing from the URL beyond the host may appear anywhere in the report.
    const everything = JSON.stringify([message, options])
    for (const secret of SECRETS) expect(everything).not.toContain(secret)
    expect(everything).not.toContain('/steal/path')
    expect(everything).not.toContain('8443')
}

beforeEach(() => {
    captureMessageMock.mockClear()
})

describe('authorize reports a refused redirect_uri', () => {
    it('warns with route, provider and only the host', async () => {
        const res = await authorize({
            provider: 'apple',
            redirect_uri: FOREIGN_URI,
        })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(
            'Disallowed redirect_uri',
        )
        expectOneWarning('extension/oauth/authorize', 'apple', 'evil.example')
    })

    it('reports an unparseable redirect_uri as such, not its text', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: 'not a url SECRET-CODE',
        })
        expect(res.status).toBe(400)
        expectOneWarning('extension/oauth/authorize', 'google', '<unparseable>')
    })

    it('stays quiet for an allowed extension redirect_uri', async () => {
        const res = await authorize({
            provider: 'google',
            redirect_uri: CHROME_REDIRECT,
        })
        expect(res.status).toBe(200)
        expect(captureMessageMock).not.toHaveBeenCalled()
    })
})

describe('redirect reports a refused extension destination', () => {
    it('success path: warns with the provider read from the state, and only the host', async () => {
        const res = await redirect({
            extension_redirect: FOREIGN_URI,
            code: 'SECRET-CODE',
            state: signedState('apple'),
        })
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
        expectOneWarning('extension/oauth/redirect', 'apple', 'evil.example')
    })

    it('success path: a destination swapped into the Apple envelope is reported too', async () => {
        const form = new FormData()
        form.append('code', 'SECRET-CODE')
        form.append('state', envelope(FOREIGN_URI, signedState('google')))
        const res = await redirectPOST(
            new NextRequest(`${BASE}/api/extension/oauth/redirect`, {
                method: 'POST',
                body: form,
            }),
        )
        expect(res.status).toBe(400)
        expectOneWarning('extension/oauth/redirect', 'google', 'evil.example')
    })

    it('error path: warns, and still answers the JSON 400 (no redirect)', async () => {
        const res = await redirect({
            error: 'access_denied',
            extension_redirect: FOREIGN_URI,
            state: 'SECRET-STATE-not-ours',
        })
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
        // A state that is not our signed shape tags the provider 'unknown'.
        expectOneWarning('extension/oauth/redirect', 'unknown', 'evil.example')
    })

    it('does not report when no destination was supplied at all', async () => {
        const res = await redirect({ code: 'SECRET-CODE', state: 's' })
        expect(res.status).toBe(400)
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('does not report a forward to one of our own extensions', async () => {
        const res = await redirect({
            extension_redirect: CHROME_REDIRECT,
            code: 'FAKE_CODE',
            state: 's',
        })
        expect(res.headers.get('location')).not.toBeNull()
        expect(captureMessageMock).not.toHaveBeenCalled()
    })
})
