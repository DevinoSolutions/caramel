import { POST as handoff } from '@/app/api/app/web-session/handoff/route'
import { GET as redeem } from '@/app/api/app/web-session/redeem/route'
import { auth } from '@/lib/auth/auth'
import { mintExtensionSessionForUser } from '@/lib/auth/extensionOAuthSession'
import prisma from '@/lib/prisma'
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// T-9213 integration — the T-7852 app→web session handoff, round trip on the
// REAL prisma client + live Postgres + the REAL better-auth instance (no
// mocks): mint a one-time code with a real session bearer, redeem it as the
// native shell, and prove the Set-Cookie it returns is a working session.
// tests/unit/web-session-routes.test.ts mocks prisma and better-auth, so it
// cannot prove the parts that matter here: the bearer plugin resolving a real
// raw session token, the verification_tokens row the mint writes being the one
// the raw DELETE … RETURNING in redeem consumes, and the signed cookie being
// accepted by better-auth's own cookie verification.
//
// Everything created here uses a private synthetic namespace and is deleted in
// afterAll (fileParallelism is off — see vitest.integration.config.ts).
const UNIQUE = `t9213-${Date.now()}`
const EMAIL = `web-handoff-itest-${UNIQUE}@example.com`
const ORIGIN = 'http://localhost:28000'
const SHELL_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 CaramelApp/1.6.0 (android)'
const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const FAILED_REDIRECT = '/login?error=handoff_expired'

let userId: string
let bearer: string
const mintedIdentifiers = new Set<string>()

function handoffRequest(
    headers: Record<string, string>,
    next = '/profile',
): NextRequest {
    return new NextRequest(`${ORIGIN}/api/app/web-session/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ next }),
    })
}

function redeemRequest(
    code: string,
    userAgent: string = SHELL_UA,
): NextRequest {
    return new NextRequest(
        `${ORIGIN}/api/app/web-session/redeem?code=${code}`,
        { headers: { 'user-agent': userAgent } },
    )
}

function handoffIdentifier(code: string): string {
    return `app-web-handoff:${createHash('sha256').update(code).digest('hex')}`
}

function codeRows(code: string): Promise<number> {
    return prisma.verification.count({
        where: { identifier: handoffIdentifier(code) },
    })
}

/** Mints a real code with the real bearer; returns the code from the URL. */
async function mintCode(next = '/profile'): Promise<string> {
    const res = await handoff(
        handoffRequest({ authorization: `Bearer ${bearer}` }, next),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; expiresInSeconds: number }
    expect(body.expiresInSeconds).toBe(60)
    const code = new URL(body.url).searchParams.get('code')
    if (!code) throw new Error('handoff response carried no code')
    mintedIdentifiers.add(handoffIdentifier(code))
    return code
}

beforeAll(async () => {
    const user = await prisma.user.create({
        data: { name: 'Web Handoff Itest', email: EMAIL, emailVerified: true },
    })
    userId = user.id
    const minted = await mintExtensionSessionForUser(userId)
    if (!minted) throw new Error('could not mint a session for the test user')
    bearer = minted.token
})

afterAll(async () => {
    await prisma.verification.deleteMany({
        where: { identifier: { in: Array.from(mintedIdentifiers) } },
    })
    await prisma.session.deleteMany({ where: { userId } })
    await prisma.account.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
})

describe('app web-session handoff (T-7852) — real DB + real better-auth', () => {
    it('mint → redeem once: Set-Cookie is a working session; a second redeem is refused', async () => {
        const code = await mintCode('/profile')

        // A non-shell browser is refused BEFORE the code is touched.
        const browser = await redeem(redeemRequest(code, BROWSER_UA))
        expect(browser.status).toBe(303)
        expect(browser.headers.get('location')).toBe(FAILED_REDIRECT)
        expect(browser.headers.get('set-cookie')).toBeNull()
        expect(await codeRows(code)).toBe(1)

        const first = await redeem(redeemRequest(code))
        expect(first.status).toBe(303)
        expect(first.headers.get('location')).toBe('/profile')
        const setCookie = first.headers.get('set-cookie')
        if (!setCookie) throw new Error('redeem returned no Set-Cookie')
        expect(setCookie).toContain('better-auth.session_token=')
        expect(setCookie.toLowerCase()).toContain('httponly')

        // The cookie must be a WORKING session: better-auth's own cookie
        // verification resolves it to the test user and the minted session.
        const cookieHeader = setCookie.split(';')[0]
        const resolved = await auth.api.getSession({
            headers: new Headers({ cookie: cookieHeader }),
        })
        expect(resolved?.user.id).toBe(userId)
        const dbSession = await prisma.session.findFirst({
            where: { userId, token: bearer },
        })
        expect(dbSession).not.toBeNull()
        expect(resolved?.session.id).toBe(dbSession?.id)

        // Single use: the row is gone and the same code is refused.
        expect(await codeRows(code)).toBe(0)
        const second = await redeem(redeemRequest(code))
        expect(second.status).toBe(303)
        expect(second.headers.get('location')).toBe(FAILED_REDIRECT)
        expect(second.headers.get('set-cookie')).toBeNull()
    })

    it('an expired code is refused and consumed', async () => {
        const code = await mintCode('/coupons')
        // The code's 60 s TTL is `expiresAt` on the verification row; age it
        // in the DB rather than faking timers across the Postgres round trip.
        const aged = await prisma.verification.updateMany({
            where: { identifier: handoffIdentifier(code) },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        })
        expect(aged.count).toBe(1)

        const res = await redeem(redeemRequest(code))
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe(FAILED_REDIRECT)
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(await codeRows(code)).toBe(0)
    })

    it('a code whose session was revoked after minting is refused', async () => {
        const code = await mintCode('/welcome')
        await prisma.session.deleteMany({ where: { token: bearer } })
        const res = await redeem(redeemRequest(code))
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe(FAILED_REDIRECT)
        expect(res.headers.get('set-cookie')).toBeNull()

        // Later tests need a live bearer again.
        const minted = await mintExtensionSessionForUser(userId)
        if (!minted) throw new Error('could not re-mint a session')
        bearer = minted.token
    })

    it('mint refuses an absent, malformed, unknown, or cookie-only credential', async () => {
        // Sign in via a redeemed code so a real session cookie exists to present alone.
        const code = await mintCode('/profile')
        const redeemed = await redeem(redeemRequest(code))
        const cookie = redeemed.headers.get('set-cookie')?.split(';')[0]
        if (!cookie) throw new Error('redeem returned no Set-Cookie')

        const countRows = () =>
            prisma.verification.count({
                where: { identifier: { startsWith: 'app-web-handoff:' } },
            })
        const before = await countRows()

        const absent = await handoff(handoffRequest({}))
        expect(absent.status).toBe(401)

        const notBearer = await handoff(
            handoffRequest({ authorization: `Basic ${bearer}` }),
        )
        expect(notBearer.status).toBe(401)

        const unknown = await handoff(
            handoffRequest({
                authorization: 'Bearer not-a-real-session-token',
            }),
        )
        expect(unknown.status).toBe(401)

        const cookieOnly = await handoff(handoffRequest({ cookie }))
        expect(cookieOnly.status).toBe(401)

        // Refusals wrote nothing.
        expect(await countRows()).toBe(before)
    })
})
