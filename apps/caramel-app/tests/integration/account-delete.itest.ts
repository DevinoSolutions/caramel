import { POST as deleteAccount } from '@/app/api/account/delete/route'
import prisma from '@/lib/prisma'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/account/delete against the REAL schema (T-4906, App Review
// 5.1.1(v)). The unit suite (tests/unit/account-delete.test.ts) proves the
// route issues the right statements; only a live Postgres proves what the
// DELETE of the user row then does through the foreign keys, which is the whole
// contract: sessions/accounts/favorites/savings/reports CASCADE away, a coupon
// the user submitted survives with its attribution SET NULL, and the rows that
// carry the person with NO foreign key (site-suggestion email, one-time
// verification tokens) are scrubbed by the route itself.
//
// Private namespace (one `acct-delete-itest` email family + coupon ids from a
// far-away range) that no seed row or other integration file touches;
// everything is removed in cleanup so the file is idempotent and re-runnable.
// The harness/CI runs `prisma migrate deploy` first and DATABASE_URL is the
// integration config's, so this file needs no skip gate of its own (it is not
// in the e2e suite, which is the one that must run without a database).

// Only better-auth's session lookup is stood in for (which user withRoute
// resolves is pinned by its own tests); everything else, prisma and the FKs
// included, is real.
const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const FAMILY = 'acct-delete-itest.example'
const USER_EMAIL = `deleter@${FAMILY}`
const BYSTANDER_EMAIL = `bystander@${FAMILY}`
const SUBMITTED_COUPON_ID = '9900000001'
const CATALOG_COUPON_ID = '9900000002'

let userId = ''
let bystanderId = ''

async function cleanup() {
    await prisma.siteSuggestion.deleteMany({
        where: { domain: { endsWith: FAMILY } },
    })
    await prisma.verification.deleteMany({
        where: { identifier: { contains: FAMILY } },
    })
    await prisma.verification.deleteMany({
        where: { value: { startsWith: 'acct-delete-itest-' } },
    })
    // Reports and savings cascade off the user or the coupon; coupons last.
    await prisma.coupon.deleteMany({
        where: { id: { in: [SUBMITTED_COUPON_ID, CATALOG_COUPON_ID] } },
    })
    await prisma.user.deleteMany({
        where: { email: { endsWith: `@${FAMILY}` } },
    })
}

function callDelete() {
    return deleteAccount(
        // No Origin header: the native app's request shape.
        new NextRequest('http://localhost/api/account/delete', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: 'Bearer acct-delete-itest-bearer',
            },
            body: JSON.stringify({ confirm: 'DELETE' }),
        }),
    )
}

function couponData(id: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        code: `ITEST${id}`,
        site: `shop.${FAMILY}`,
        title: 'acct delete itest',
        description: 'acct delete itest',
        status: 'active',
        ...extra,
    }
}

beforeEach(async () => {
    await cleanup()
    const user = await prisma.user.create({
        data: { email: USER_EMAIL, name: 'Deleter', emailVerified: true },
        select: { id: true },
    })
    const bystander = await prisma.user.create({
        data: {
            email: BYSTANDER_EMAIL,
            name: 'Bystander',
            emailVerified: true,
        },
        select: { id: true },
    })
    userId = user.id
    bystanderId = bystander.id
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue({
        user: { id: userId, email: USER_EMAIL },
    })
})

afterEach(cleanup)

describe('POST /api/account/delete — what the real foreign keys do', () => {
    it('removes the user and cascades the login and the data; keeps the submitted coupon, unattributed; scrubs the FK-less rows', async () => {
        const farFuture = new Date(Date.now() + 86_400_000)
        // A catalog coupon the user's report and saving point at, plus one
        // they submitted themselves.
        await prisma.coupon.create({ data: couponData(CATALOG_COUPON_ID) })
        await prisma.coupon.create({
            data: couponData(SUBMITTED_COUPON_ID, {
                submittedByUserId: userId,
                submissionSource: 'manual',
            }),
        })
        await prisma.session.create({
            data: {
                token: 'acct-delete-itest-session',
                expiresAt: farFuture,
                userId,
            },
        })
        await prisma.account.create({
            data: {
                accountId: 'acct-delete-itest-google',
                providerId: 'google',
                userId,
            },
        })
        await prisma.favoriteStore.create({
            data: { userId, storeName: `fav.${FAMILY}` },
        })
        await prisma.savingsEvent.create({
            data: {
                userId,
                couponId: CATALOG_COUPON_ID,
                store: `shop.${FAMILY}`,
                code: 'SAVE10',
                amountCents: 1000,
                occurredAt: new Date(),
                clientEventId: 'acct-delete-itest-event',
            },
        })
        await prisma.couponReport.create({
            data: {
                couponId: CATALOG_COUPON_ID,
                userId,
                outcome: 'worked',
            },
        })
        // A suggestion made while signed in (user_id set) and one made signed
        // out under the same address (user_id NULL, email only).
        await prisma.siteSuggestion.create({
            data: {
                domain: `signed-in.${FAMILY}`,
                rawUrl: `https://signed-in.${FAMILY}/`,
                userId,
                requesterEmail: USER_EMAIL,
                source: 'web',
                userAgent: 'itest/1.0',
            },
        })
        await prisma.siteSuggestion.create({
            data: {
                domain: `signed-out.${FAMILY}`,
                rawUrl: `https://signed-out.${FAMILY}/`,
                requesterEmail: USER_EMAIL,
                source: 'web',
                userAgent: 'itest/1.0',
            },
        })
        // One-time tokens: by address (two forms), by user id (reset), and a
        // bystander's that must survive.
        await prisma.verification.createMany({
            data: [
                {
                    identifier: USER_EMAIL,
                    value: 'acct-delete-itest-by-address',
                    expiresAt: farFuture,
                },
                {
                    identifier: `email-verification-otp-${USER_EMAIL}`,
                    value: 'acct-delete-itest-by-otp',
                    expiresAt: farFuture,
                },
                {
                    identifier: `reset-password:acct-delete-itest-token`,
                    value: userId,
                    expiresAt: farFuture,
                },
                {
                    identifier: BYSTANDER_EMAIL,
                    value: 'acct-delete-itest-bystander',
                    expiresAt: farFuture,
                },
                {
                    // Another person's address that merely ENDS with this one
                    // (hyphen, colon and plain-prefix variants): not theirs.
                    identifier: `a-${USER_EMAIL}`,
                    value: 'acct-delete-itest-lookalike-hyphen',
                    expiresAt: farFuture,
                },
                {
                    identifier: `a:${USER_EMAIL}`,
                    value: 'acct-delete-itest-lookalike-colon',
                    expiresAt: farFuture,
                },
                {
                    identifier: `sign-in-otp-a-${USER_EMAIL}`,
                    value: 'acct-delete-itest-lookalike-otp',
                    expiresAt: farFuture,
                },
                {
                    identifier: `x${USER_EMAIL}`,
                    value: 'acct-delete-itest-lookalike',
                    expiresAt: farFuture,
                },
            ],
        })
        // And a bystander's own data, which no part of the delete may touch.
        await prisma.favoriteStore.create({
            data: { userId: bystanderId, storeName: `fav.${FAMILY}` },
        })

        const res = await callDelete()

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: true,
            scrubbed: { siteSuggestions: 2 },
        })

        // The user and everything that cascades.
        expect(
            await prisma.user.findUnique({ where: { id: userId } }),
        ).toBeNull()
        expect(await prisma.session.count({ where: { userId } })).toBe(0)
        expect(await prisma.account.count({ where: { userId } })).toBe(0)
        expect(await prisma.favoriteStore.count({ where: { userId } })).toBe(0)
        expect(await prisma.savingsEvent.count({ where: { userId } })).toBe(0)
        expect(await prisma.couponReport.count({ where: { userId } })).toBe(0)

        // SetNull: the submitted coupon keeps its code, loses the attribution.
        const submitted = await prisma.coupon.findUnique({
            where: { id: SUBMITTED_COUPON_ID },
        })
        expect(submitted).not.toBeNull()
        expect(submitted?.submittedByUserId).toBeNull()
        expect(submitted?.code).toBe(`ITEST${SUBMITTED_COUPON_ID}`)
        // The catalog coupon the report and saving pointed at is untouched.
        expect(
            await prisma.coupon.findUnique({
                where: { id: CATALOG_COUPON_ID },
            }),
        ).not.toBeNull()

        // Site suggestions: rows stay (the store request is ops data) but no
        // trace of the person is left, whichever way it was recorded.
        const suggestions = await prisma.siteSuggestion.findMany({
            where: { domain: { endsWith: FAMILY } },
            orderBy: { domain: 'asc' },
        })
        expect(suggestions).toHaveLength(2)
        for (const row of suggestions) {
            expect(row.userId).toBeNull()
            expect(row.requesterEmail).toBeNull()
            expect(row.userAgent).toBeNull()
        }

        // Verification tokens: the user's are gone, the others stay.
        const remaining = await prisma.verification.findMany({
            where: { value: { startsWith: 'acct-delete-itest-' } },
            select: { value: true },
        })
        expect(remaining.map(r => r.value).sort()).toEqual([
            'acct-delete-itest-bystander',
            'acct-delete-itest-lookalike',
            'acct-delete-itest-lookalike-colon',
            'acct-delete-itest-lookalike-hyphen',
            'acct-delete-itest-lookalike-otp',
        ])

        // The bystander and their data are intact.
        expect(
            await prisma.user.findUnique({ where: { id: bystanderId } }),
        ).not.toBeNull()
        expect(
            await prisma.favoriteStore.count({
                where: { userId: bystanderId },
            }),
        ).toBe(1)
    })

    it('a second call after the user is gone deletes nothing and does not throw (a lost race reaches the handler)', async () => {
        const first = await callDelete()
        expect(first.status).toBe(200)

        // The auth gate would 401 a real retry (sessions are gone); the mock
        // still resolves the session, which is exactly the lost-race shape.
        const second = await callDelete()
        expect(second.status).toBe(200)
        expect(await second.json()).toEqual({
            deleted: false,
            scrubbed: { siteSuggestions: 0 },
        })
    })
})
