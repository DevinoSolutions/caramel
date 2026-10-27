import { POST } from '@/app/api/dev-proof/session/route'
import {
    DEV_PROOF_CALLS_PER_HOUR,
    DEV_PROOF_EMAIL_PATTERN,
    bearerMatches,
    isProductionHost,
    requestTouchesProductionHost,
} from '@/lib/devProof'
import { NextRequest } from 'next/server'
import { createHash, createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-9413 — POST /api/dev-proof/session, the dev-only throwaway-session mint.
// What this file pins is the route's CONTRACT: the two gates (env secret, then
// production host) answer a bare 404, the bearer and the email pattern are
// enforced in that order, the audit record is written for every call that got
// past the 404 gate, and nothing secret reaches a log. The mint itself
// (mintExtensionSession) and the database are ANNOUNCED DOUBLES here: the real
// mint against real Postgres is tests/integration/dev-proof-session.itest.ts.
const SECRET = 'dev-proof-fixture-secret-0123456789abcdef'
const MINTED_TOKEN = 'minted-session-token-fixture-not-a-real-bearer'
const EMAIL = 'devproof+walk-1@devino.ca'
const EXPIRES_AT = new Date('2026-11-03T12:00:00.000Z')

const {
    envMock,
    mintMock,
    findSessionMock,
    checkRateLimitMock,
    captureMessageMock,
    captureExceptionMock,
    addBreadcrumbMock,
    baseUrlMock,
} = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
    // NEXT_PUBLIC_BASE_URL as baked into the build; reset to the dev deployment's per test.
    baseUrlMock: { value: 'https://dev.grabcaramel.com' },
    mintMock: vi.fn(
        async (_args: {
            provider: string
            providerUser: Record<string, unknown>
            tokens: Record<string, unknown>
        }): Promise<{
            token: string
            username: string | null
            image: string | null
        }> => ({
            token: 'overwritten-in-beforeEach',
            username: null,
            image: null,
        }),
    ),
    findSessionMock: vi.fn(async (_args: unknown) => ({
        expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })),
    checkRateLimitMock: vi.fn(
        async (_req: unknown, _kind: string) => null as unknown,
    ),
    captureMessageMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    addBreadcrumbMock: vi.fn(),
}))

// The real env schema, with the dev-proof secret and the configured public
// origin overridable per test. Nothing else under test reads it.
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
// The baked public origin defaults to PRODUCTION when unset, which would make
// every call below look like a production host; this is the dev deployment's.
vi.mock('@/lib/env.client', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/env.client')>()),
    // A getter, so a test can change what the route sees (it reads BASE_URL per request).
    get BASE_URL() {
        return baseUrlMock.value
    },
}))
vi.mock('@/lib/auth/extensionOAuthSession', () => ({
    mintExtensionSession: mintMock,
}))
vi.mock('@/lib/prisma', () => ({
    default: { session: { findUniqueOrThrow: findSessionMock } },
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
    addBreadcrumb: addBreadcrumbMock,
    setUser: vi.fn(),
}))
// Only the burst limiter's round trip is stubbed; it is asserted below.
vi.mock('@/lib/rateLimit', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/rateLimit')>()),
    checkRateLimit: checkRateLimitMock,
}))

let ipCounter = 0

interface CallOptions {
    url?: string
    bearer?: string | null
    body?: unknown
    headers?: Record<string, string>
    /** A fresh client IP per call unless a test pins one (the hourly budget is per IP). */
    ip?: string
}

function call(options: CallOptions = {}): Promise<Response> {
    const headers = new Headers({
        'content-type': 'application/json',
        'cf-connecting-ip': options.ip ?? `203.0.113.${++ipCounter % 250}`,
        ...options.headers,
    })
    if (options.bearer !== null) {
        headers.set('authorization', `Bearer ${options.bearer ?? SECRET}`)
    }
    return POST(
        new NextRequest(
            options.url ?? 'https://dev.grabcaramel.com/api/dev-proof/session',
            {
                method: 'POST',
                headers,
                body: JSON.stringify(options.body ?? { email: EMAIL }),
            },
        ),
    )
}

function auditOutcomes(): string[] {
    return captureMessageMock.mock.calls.map(
        ([message]) => String(message).split(': ')[1] ?? '',
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    envMock.DEV_PROOF_SESSION_SECRET = SECRET
    envMock.BETTER_AUTH_URL = 'https://dev.grabcaramel.com'
    baseUrlMock.value = 'https://dev.grabcaramel.com'
    mintMock.mockResolvedValue({
        token: MINTED_TOKEN,
        username: 'Devproof tester',
        image: null,
    })
    findSessionMock.mockResolvedValue({ expiresAt: EXPIRES_AT })
    checkRateLimitMock.mockResolvedValue(null)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

describe('gate 1: the secret exists only on the dev deployment', () => {
    it('answers a bare 404 when DEV_PROOF_SESSION_SECRET is unset, and does nothing else', async () => {
        delete envMock.DEV_PROOF_SESSION_SECRET

        const res = await call()

        expect(res.status).toBe(404)
        expect(await res.text()).toBe('')
        expect(mintMock).not.toHaveBeenCalled()
        // A disabled route is indistinguishable from a missing one: no audit
        // noise for production probes either.
        expect(captureMessageMock).not.toHaveBeenCalled()
        expect(console.info).not.toHaveBeenCalled()
    })

    it('answers the same 404 to a caller who presents the right bearer', async () => {
        delete envMock.DEV_PROOF_SESSION_SECRET

        const res = await call({ bearer: SECRET })

        expect(res.status).toBe(404)
        expect(mintMock).not.toHaveBeenCalled()
    })
})

describe('gate 2: a production host is refused even with the secret set', () => {
    const productionCases: [string, CallOptions][] = [
        [
            'the request URL',
            { url: 'https://grabcaramel.com/api/dev-proof/session' },
        ],
        [
            'www in the request URL',
            { url: 'https://www.grabcaramel.com/api/dev-proof/session' },
        ],
        [
            'X-Forwarded-Host',
            { headers: { 'x-forwarded-host': 'grabcaramel.com' } },
        ],
        [
            'X-Forwarded-Host with a port and trailing dot',
            { headers: { 'x-forwarded-host': 'WWW.GrabCaramel.com.:443' } },
        ],
        [
            'the first entry of a forwarded host list',
            {
                headers: {
                    'x-forwarded-host': 'grabcaramel.com, dev.grabcaramel.com',
                },
            },
        ],
        [
            'a production entry LAST in a forwarded host list',
            {
                headers: {
                    'x-forwarded-host':
                        'dev.grabcaramel.com, www.grabcaramel.com',
                },
            },
        ],
        [
            'a production entry in the MIDDLE of a forwarded host list',
            {
                headers: {
                    'x-forwarded-host':
                        'dev.grabcaramel.com,grabcaramel.com:443,localhost',
                },
            },
        ],
        [
            'an empty entry in a forwarded host list (fail closed)',
            { headers: { 'x-forwarded-host': 'dev.grabcaramel.com,' } },
        ],
        [
            'any other grabcaramel.com subdomain',
            { headers: { 'x-forwarded-host': 'docs.grabcaramel.com' } },
        ],
    ]
    it.each(productionCases)('404s on %s', async (_label, options) => {
        const res = await call(options)

        expect(res.status).toBe(404)
        expect(await res.text()).toBe('')
        expect(mintMock).not.toHaveBeenCalled()
        expect(auditOutcomes()).toEqual(['refused_production_host'])
    })

    it('404s when the app itself is configured as production, whatever the Host says', async () => {
        envMock.BETTER_AUTH_URL = 'https://grabcaramel.com'

        const res = await call()

        expect(res.status).toBe(404)
        expect(mintMock).not.toHaveBeenCalled()
    })

    it('404s when the baked NEXT_PUBLIC_BASE_URL is production, even though BETTER_AUTH_URL says dev', async () => {
        baseUrlMock.value = 'https://grabcaramel.com'
        envMock.BETTER_AUTH_URL = 'https://dev.grabcaramel.com'

        const res = await call()

        expect(res.status).toBe(404)
        expect(mintMock).not.toHaveBeenCalled()
        expect(auditOutcomes()).toEqual(['refused_production_host'])
    })

    it('404s when BETTER_AUTH_URL is production, even though the baked NEXT_PUBLIC_BASE_URL says dev', async () => {
        baseUrlMock.value = 'https://dev.grabcaramel.com'
        envMock.BETTER_AUTH_URL = 'https://grabcaramel.com'

        const res = await call()

        expect(res.status).toBe(404)
        expect(mintMock).not.toHaveBeenCalled()
        expect(auditOutcomes()).toEqual(['refused_production_host'])
    })

    it('serves the dev deployment, localhost and an emulator host', async () => {
        for (const url of [
            'https://dev.grabcaramel.com/api/dev-proof/session',
            'http://localhost:28000/api/dev-proof/session',
            'http://10.0.2.2:28000/api/dev-proof/session',
        ]) {
            expect((await call({ url })).status).toBe(200)
        }
    })

    it('classifies hosts: every grabcaramel.com name but the dev one is production, and unparseable input fails closed', () => {
        expect(isProductionHost('grabcaramel.com')).toBe(true)
        expect(isProductionHost('www.grabcaramel.com')).toBe(true)
        expect(isProductionHost('docs.grabcaramel.com')).toBe(true)
        expect(isProductionHost('dev.grabcaramel.com')).toBe(false)
        expect(isProductionHost('localhost')).toBe(false)
        expect(isProductionHost('notgrabcaramel.com')).toBe(false)

        const base = {
            host: null,
            forwardedHost: null,
            url: 'http://localhost/x',
            publicOrigins: [],
        }
        expect(requestTouchesProductionHost(base)).toBe(false)
        expect(
            requestTouchesProductionHost({
                ...base,
                publicOrigins: ['https://grabcaramel.com'],
            }),
        ).toBe(true)
        expect(
            requestTouchesProductionHost({ ...base, host: 'http://[bad' }),
        ).toBe(true)
    })
})

describe('auth: a timing-safe Bearer check', () => {
    const badBearerCases: [string, CallOptions][] = [
        ['a wrong bearer', { bearer: 'not-the-secret' }],
        ['a bearer of a different length', { bearer: `${SECRET}-extra` }],
        ['an empty bearer', { bearer: '' }],
        ['no Authorization header', { bearer: null }],
        [
            'a Basic scheme',
            { bearer: null, headers: { authorization: `Basic ${SECRET}` } },
        ],
    ]
    it.each(badBearerCases)(
        '401s %s without minting',
        async (_label, options) => {
            const res = await call(options)

            expect(res.status).toBe(401)
            expect(mintMock).not.toHaveBeenCalled()
            expect(auditOutcomes()).toEqual(['unauthorized'])
        },
    )

    it('compares equal-length digests, so no input length can throw or leak', () => {
        expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true)
        expect(bearerMatches(null, SECRET)).toBe(false)
        expect(bearerMatches('', SECRET)).toBe(false)
        expect(bearerMatches('x'.repeat(10_000), SECRET)).toBe(false)
        expect(bearerMatches(SECRET, SECRET)).toBe(false)
    })

    it('checks the bearer before the email, so an unauthenticated caller cannot probe the pattern', async () => {
        const res = await call({
            bearer: 'wrong',
            body: { email: 'someone@example.com' },
        })

        expect(res.status).toBe(401)
    })
})

describe('scope: only a throwaway devproof+ address', () => {
    it.each([
        'victim@gmail.com',
        'devproof+x@example.com',
        'devproof@devino.ca',
        'devproof+@devino.ca',
        'amin@devino.ca',
        'Devproof+x@devino.ca',
        'devproof+X@devino.ca',
        'devproof+a.b@devino.ca',
        'devproof+a+b@devino.ca',
        `devproof+${'a'.repeat(41)}@devino.ca`,
        'devproof+x@devino.ca\n',
        ' devproof+x@devino.ca',
        'devproof+x@devino.ca.evil.com',
        'x@devino.ca,devproof+x@devino.ca',
    ])('422s %j without minting', async email => {
        const res = await call({ body: { email } })

        expect(res.status).toBe(422)
        expect(mintMock).not.toHaveBeenCalled()
        expect(auditOutcomes()).toEqual(['invalid_email'])
    })

    it('422s a body with no email (withRoute schema)', async () => {
        const res = await call({ body: {} })

        expect(res.status).toBe(422)
        expect(mintMock).not.toHaveBeenCalled()
    })

    it('accepts the documented shape, including the 40-character slug limit', () => {
        expect(DEV_PROOF_EMAIL_PATTERN.test('devproof+walk-1@devino.ca')).toBe(
            true,
        )
        expect(
            DEV_PROOF_EMAIL_PATTERN.test(
                `devproof+${'a'.repeat(40)}@devino.ca`,
            ),
        ).toBe(true)
    })
})

describe('the happy path', () => {
    it('mints for a devproof+ address and returns only the bearer and its expiry', async () => {
        const res = await call()

        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({
            token: MINTED_TOKEN,
            expiresAt: EXPIRES_AT.toISOString(),
        })
        expect(mintMock).toHaveBeenCalledTimes(1)
        expect(mintMock.mock.calls[0]?.[0]).toEqual({
            provider: 'google',
            providerUser: {
                id: `devproof:${EMAIL}`,
                email: EMAIL,
                name: 'Devproof tester',
                emailVerified: true,
            },
            tokens: {},
        })
        expect(findSessionMock).toHaveBeenCalledWith({
            where: { token: MINTED_TOKEN },
            select: { expiresAt: true },
        })
    })

    it('500s through handleRouteError, with an audit record, when the mint fails', async () => {
        const failure = new Error('database is down')
        mintMock.mockRejectedValueOnce(failure)

        const res = await call()

        expect(res.status).toBe(500)
        expect(captureExceptionMock).toHaveBeenCalledWith(
            failure,
            expect.anything(),
        )
        expect(auditOutcomes()).toEqual(['error'])
    })
})

describe('audit: every call past the 404 gate leaves a record that holds no secret', () => {
    it('writes a structured log line, a breadcrumb and an info Sentry message with the outcome, email and requester hash', async () => {
        await call({ ip: '198.51.100.7' })

        expect(auditOutcomes()).toEqual(['minted'])
        expect(captureMessageMock).toHaveBeenCalledWith(
            'dev-proof session call: minted',
            expect.objectContaining({
                level: 'info',
                tags: { route: 'dev-proof/session', outcome: 'minted' },
            }),
        )
        const data = addBreadcrumbMock.mock.calls[0]?.[0]?.data as Record<
            string,
            unknown
        >
        expect(data).toMatchObject({
            event: 'dev_proof_session',
            outcome: 'minted',
            email: EMAIL,
        })
        // A keyed hash, not the address and not a bare SHA-256 of it.
        expect(data.requesterHash).toBe(
            createHmac('sha256', SECRET)
                .update('198.51.100.7')
                .digest('hex')
                .slice(0, 16),
        )
        expect(data.requesterHash).not.toBe(
            createHash('sha256')
                .update('198.51.100.7')
                .digest('hex')
                .slice(0, 16),
        )
        expect(JSON.stringify(data)).not.toContain('198.51.100.7')
        expect(vi.mocked(console.info).mock.calls[0]?.[0]).toContain(
            '"event":"dev_proof_session"',
        )
    })

    it('records refused calls too, and never the secret, the Authorization header, or the minted token', async () => {
        await call({ bearer: 'a-guess' })
        await call({ body: { email: 'victim@gmail.com' } })
        await call()
        await call({ url: 'https://grabcaramel.com/api/dev-proof/session' })

        expect(auditOutcomes()).toEqual([
            'unauthorized',
            'invalid_email',
            'minted',
            'refused_production_host',
        ])
        const everything = JSON.stringify([
            captureMessageMock.mock.calls,
            addBreadcrumbMock.mock.calls,
            vi.mocked(console.info).mock.calls,
        ])
        expect(everything).not.toContain(SECRET)
        expect(everything).not.toContain('a-guess')
        expect(everything).not.toContain(MINTED_TOKEN)
        expect(everything).not.toContain('victim@gmail.com')
    })
})

describe('rate limit', () => {
    it("applies withRoute's mutation limiter to every call that reaches the route", async () => {
        await call()

        expect(checkRateLimitMock).toHaveBeenCalledTimes(1)
        expect(checkRateLimitMock.mock.calls[0]?.[1]).toBe('mutation')
    })

    it(`allows ${DEV_PROOF_CALLS_PER_HOUR} calls an hour per client, then 429s, refused calls included`, async () => {
        const ip = '192.0.2.99'
        // Wrong bearers spend the budget too, which is what caps secret guessing.
        for (let i = 0; i < DEV_PROOF_CALLS_PER_HOUR; i++) {
            expect((await call({ ip, bearer: 'a-guess' })).status).toBe(401)
        }

        const limited = await call({ ip })

        expect(limited.status).toBe(429)
        expect(mintMock).not.toHaveBeenCalled()
        expect(auditOutcomes().slice(-1)).toEqual(['rate_limited'])
        // Another client has its own budget.
        expect((await call({ ip: '192.0.2.100' })).status).toBe(200)
    })
})
