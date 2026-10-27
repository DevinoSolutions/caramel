import { POST } from '@/app/api/dev-proof/session/route'
import prisma from '@/lib/prisma'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// T-9413 — POST /api/dev-proof/session against the REAL schema. The unit suite
// (tests/unit/dev-proof-session-route.test.ts) mocks the mint; only a live
// Postgres proves what the mint does through the real constraints: the throwaway
// user is created once and found again (no duplicate user or provider account on
// the second call), every call mints a fresh session row, and the expiry in the
// response is the stored row's.
//
// The route is enabled for this file only through the hoisted env below; the
// secret is a fixture. The public origin is the dev deployment's, because an
// unset NEXT_PUBLIC_BASE_URL defaults to production and the route (correctly)
// refuses that. Rate limiting is stubbed out only for withRoute's burst limiter.
const SECRET = 'dev-proof-itest-secret-0123456789abcdefghij'

vi.hoisted(() => {
    process.env.DEV_PROOF_SESSION_SECRET =
        'dev-proof-itest-secret-0123456789abcdefghij'
    process.env.BETTER_AUTH_URL = 'https://dev.grabcaramel.com'
})
vi.mock('@/lib/env.client', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/env.client')>()),
    BASE_URL: 'https://dev.grabcaramel.com',
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const SLUG = `itest-${Date.now()}`
const EMAIL = `devproof+${SLUG}@devino.ca`
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function mint(email: string, ip: string) {
    return POST(
        new NextRequest('https://dev.grabcaramel.com/api/dev-proof/session', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${SECRET}`,
                'cf-connecting-ip': ip,
            },
            body: JSON.stringify({ email }),
        }),
    )
}

async function cleanup() {
    // Sessions and accounts cascade off the user; delete explicitly and in FK
    // order so cleanup never depends on cascade config.
    const user = await prisma.user.findFirst({ where: { email: EMAIL } })
    if (user) {
        await prisma.session.deleteMany({ where: { userId: user.id } })
        await prisma.account.deleteMany({ where: { userId: user.id } })
        await prisma.user.delete({ where: { id: user.id } })
    }
}

beforeAll(cleanup)
afterAll(cleanup)

describe('dev-proof session mint — real DB', () => {
    it('creates the throwaway user once, then mints a fresh session for the same user', async () => {
        const before = Date.now()
        const first = await mint(EMAIL, '198.51.100.21')
        expect(first.status).toBe(200)
        const firstBody = (await first.json()) as {
            token: string
            expiresAt: string
        }

        const user = await prisma.user.findFirstOrThrow({
            where: { email: EMAIL },
            include: { accounts: true, sessions: true },
        })
        expect(user.emailVerified).toBe(true)
        expect(user.accounts).toHaveLength(1)
        expect(user.accounts[0]).toMatchObject({
            providerId: 'google',
            accountId: `devproof:${EMAIL}`,
        })
        expect(user.sessions).toHaveLength(1)
        expect(user.sessions[0]?.token).toBe(firstBody.token)
        // The response carries the stored row's expiry, ~7 days out.
        expect(firstBody.expiresAt).toBe(
            user.sessions[0]?.expiresAt.toISOString(),
        )
        const lifetimeMs = new Date(firstBody.expiresAt).getTime() - before
        expect(Math.abs(lifetimeMs - SEVEN_DAYS_MS)).toBeLessThan(60_000)

        const second = await mint(EMAIL, '198.51.100.22')
        expect(second.status).toBe(200)
        const secondBody = (await second.json()) as { token: string }
        expect(secondBody.token).not.toBe(firstBody.token)

        expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1)
        expect(
            await prisma.account.count({
                where: { providerId: 'google', accountId: `devproof:${EMAIL}` },
            }),
        ).toBe(1)
        expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
            2,
        )
    })

    it('creates nothing for an address outside the pattern', async () => {
        const outsider = `victim-${SLUG}@example.com`

        const res = await mint(outsider, '198.51.100.23')

        expect(res.status).toBe(422)
        expect(await prisma.user.count({ where: { email: outsider } })).toBe(0)
    })
})
