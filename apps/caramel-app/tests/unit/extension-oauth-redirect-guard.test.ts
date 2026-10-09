import {
    GET as redirectGET,
    POST as redirectPOST,
} from '@/app/api/extension/oauth/redirect/route'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// /api/extension/oauth/redirect is the intermediate hop that ONLY the Apple
// leg uses: Apple cannot form_post to chromiumapp.org, so it posts here and
// this route forwards the authorization code on to the extension.
//
// That makes it the sharpest edge in the auth surface and it had no test at
// all. It is unauthenticated by design (Apple/Google call it server-to-server,
// so there is no session and no CORS context), it takes its destination from
// an `extension_redirect` query param OR from base64 JSON hidden inside
// `state`, and it 302s a freshly-minted authorization code to whatever that
// destination says. A weak origin check here is a code-harvesting hole.
//
// The guard was verified against the LIVE dev deployment on 2026-08-05 with
// these exact shapes; this suite is that proof frozen so it cannot regress.
// Codes below are fake strings — nothing is exchanged.
const { envMock } = vi.hoisted(() => ({
    envMock: { CHROME_EXTENSION_ORIGIN: undefined as string | undefined },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://localhost:58000' }))

const EXT = 'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/'
const ROUTE = 'https://localhost:58000/api/extension/oauth/redirect'

/** The base64 {r,s} envelope the Apple leg actually sends as `state`. */
const envelope = (redirect: string, inner = 'inner-state') =>
    Buffer.from(JSON.stringify({ r: redirect, s: inner })).toString('base64')

const get = (params: Record<string, string>) =>
    redirectGET(
        new NextRequest(`${ROUTE}?${new URLSearchParams(params).toString()}`),
    )

const body = async (res: Response) => (await res.json()) as { error?: string }

describe('extension OAuth redirect — where the code is allowed to go', () => {
    describe('rejects every destination that is not an extension', () => {
        // Each of these would hand a live authorization code to somebody else.
        const hostile: Array<[string, string]> = [
            ['a plain offsite https target', 'https://evil.example.com/'],
            [
                'a host that merely CONTAINS the allowed domain',
                'https://x.chromiumapp.org.evil.com/',
            ],
            [
                'a lookalike host missing the dot separator',
                'https://evilchromiumapp.org/',
            ],
            ['a javascript: scheme', 'javascript:alert(1)'],
            ['a data: scheme', 'data:text/html,<script>1</script>'],
            [
                'plain http to the right-looking host',
                'http://x.chromiumapp.org/',
            ],
        ]

        it.each(hostile)('refuses %s', async (_label, target) => {
            const res = await get({
                extension_redirect: target,
                code: 'FAKE_CODE',
                state: 's',
            })
            expect(res.status).toBe(400)
            expect((await body(res)).error).toMatch(
                /Disallowed extension redirect origin|Invalid extension redirect URI/,
            )
        })

        it('refuses an evil destination smuggled inside the base64 state envelope', async () => {
            // The envelope's `r` OVERRIDES extension_redirect, so it has to be
            // held to the same guard — otherwise the query param is validated
            // and the real destination sails past unchecked.
            const res = await get({
                code: 'FAKE_CODE',
                state: envelope('https://evil.example.com/'),
            })
            expect(res.status).toBe(400)
            expect((await body(res)).error).toBe(
                'Disallowed extension redirect origin',
            )
        })
    })

    describe('forwards to a genuine extension destination', () => {
        it('redirects to the chromiumapp.org target carrying code and state', async () => {
            const res = await get({
                extension_redirect: EXT,
                code: 'FAKE_CODE',
                state: 'signed-state',
            })
            expect(res.status).toBeGreaterThanOrEqual(300)
            expect(res.status).toBeLessThan(400)
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(EXT)
            expect(loc.searchParams.get('code')).toBe('FAKE_CODE')
            expect(loc.searchParams.get('state')).toBe('signed-state')
        })

        it('unwraps the envelope and forwards the INNER state, not the envelope', async () => {
            // The extension verifies the signed state it was handed at
            // authorize time. Forwarding the base64 wrapper instead would fail
            // that check for every Apple sign-in.
            const res = await get({
                code: 'FAKE_CODE',
                state: envelope(EXT, 'the-signed-state'),
            })
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(EXT)
            expect(loc.searchParams.get('state')).toBe('the-signed-state')
        })

        it('allows a chrome-extension:// destination of our own extension', async () => {
            const res = await get({
                extension_redirect:
                    'chrome-extension://gaimofgglbackoimfjopicmbmnlccfoe/callback',
                code: 'FAKE_CODE',
                state: 's',
            })
            expect(res.status).toBeGreaterThanOrEqual(300)
            expect(res.status).toBeLessThan(400)
        })
    })

    // Security report 2026-10, verified live on prod before the fix: the
    // guard used to accept ANY chromiumapp.org host / chrome-extension:// ID,
    // and the error branch redirected before any guard ran at all.
    describe('only OUR extensions — not any extension', () => {
        const FOREIGN =
            'https://aaaabbbbccccddddeeeeffffgggghhhh.chromiumapp.org/'
        const EDGE = 'https://leodahchedhnenmiengkfpmmcdendnof.chromiumapp.org/'

        afterEach(() => {
            envMock.CHROME_EXTENSION_ORIGIN = undefined
        })

        it.each([
            ['a foreign chromiumapp.org extension', FOREIGN],
            [
                'a foreign chrome-extension:// ID',
                'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/cb',
            ],
            [
                'our ID one label too deep',
                'https://x.gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/',
            ],
            [
                'our host with a port',
                'https://gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org:8443/',
            ],
            [
                'our host with userinfo',
                'https://u:p@gaimofgglbackoimfjopicmbmnlccfoe.chromiumapp.org/',
            ],
        ])('refuses to forward the code to %s', async (_label, target) => {
            const res = await get({
                extension_redirect: target,
                code: 'FAKE_CODE',
                state: 's',
            })
            expect(res.status).toBe(400)
            expect(res.headers.get('location')).toBeNull()
        })

        it('refuses a foreign extension swapped into the UNSIGNED envelope `r` of a legit Apple state', async () => {
            // The envelope `r` is not covered by the HMAC — an attacker can
            // take a genuinely-issued authorize URL and rewrite it.
            const form = new FormData()
            form.append('code', 'FAKE_CODE')
            form.append('state', envelope(FOREIGN, 'legit-signed-state'))
            const res = await redirectPOST(
                new NextRequest(ROUTE, { method: 'POST', body: form }),
            )
            expect(res.status).toBe(400)
            expect(res.headers.get('location')).toBeNull()
        })

        it('error path: is NOT an open redirect to a website', async () => {
            const res = await get({
                error: 'access_denied',
                extension_redirect: 'https://example.com/phish',
            })
            expect(res.status).toBe(400)
            expect(res.headers.get('location')).toBeNull()
            expect((await body(res)).error).toBe('access_denied')
        })

        it('error path: does not hand the error to a foreign extension either', async () => {
            const res = await get({
                error: 'access_denied',
                state: envelope(FOREIGN, 'signed'),
            })
            expect(res.status).toBe(400)
            expect(res.headers.get('location')).toBeNull()
        })

        it('forwards to the Edge Add-ons build', async () => {
            const res = await get({
                extension_redirect: EDGE,
                code: 'FAKE_CODE',
                state: 's',
            })
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(EDGE)
        })

        it("forwards to the deployment's own CHROME_EXTENSION_ORIGIN (unpacked dev build)", async () => {
            envMock.CHROME_EXTENSION_ORIGIN =
                'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh'
            const res = await get({
                extension_redirect: FOREIGN,
                code: 'FAKE_CODE',
                state: 's',
            })
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(FOREIGN)
        })
    })

    describe('refuses to forward nothing useful', () => {
        it('400s when no code was supplied', async () => {
            const res = await get({ extension_redirect: EXT, state: 's' })
            expect(res.status).toBe(400)
            expect((await body(res)).error).toBe('Missing authorization code')
        })

        it('400s when no destination was supplied', async () => {
            const res = await get({ code: 'FAKE_CODE', state: 'not-base64' })
            expect(res.status).toBe(400)
            expect((await body(res)).error).toBe(
                'Missing extension redirect URI',
            )
        })
    })

    describe("Apple's real shape: form_post", () => {
        const postForm = (fields: Record<string, string>, query = '') => {
            const form = new FormData()
            for (const [k, v] of Object.entries(fields)) form.append(k, v)
            return redirectPOST(
                new NextRequest(`${ROUTE}${query}`, {
                    method: 'POST',
                    body: form,
                }),
            )
        }

        it('reads code and state from the POSTed form and forwards them', async () => {
            const res = await postForm({
                code: 'FAKE_CODE',
                state: envelope(EXT, 'the-signed-state'),
            })
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(EXT)
            expect(loc.searchParams.get('code')).toBe('FAKE_CODE')
            expect(loc.searchParams.get('state')).toBe('the-signed-state')
        })

        it('applies the same origin guard to a POSTed destination', async () => {
            const res = await postForm({
                code: 'FAKE_CODE',
                state: envelope('https://evil.example.com/'),
            })
            expect(res.status).toBe(400)
        })

        it('passes a provider error back to the extension instead of the code', async () => {
            // A user who declines at Apple must land back on the extension with
            // an error it can render, not on a bare JSON 400 page.
            const res = await postForm({
                error: 'user_cancelled_authorize',
                state: envelope(EXT, 'the-signed-state'),
            })
            const loc = new URL(res.headers.get('location') ?? '')
            expect(loc.origin + loc.pathname).toBe(EXT)
            expect(loc.searchParams.get('error')).toBe(
                'user_cancelled_authorize',
            )
            expect(loc.searchParams.get('code')).toBeNull()
        })
    })
})
