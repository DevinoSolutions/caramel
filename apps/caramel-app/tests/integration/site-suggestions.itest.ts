import { POST } from '@/app/api/sites/suggest/route'
import prisma from '@/lib/prisma'
import {
    acknowledgeSiteSuggestions,
    listSiteSuggestions,
} from '@/lib/siteSuggestions'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Site-suggestion integration — the DB-backed sibling of
// tests/unit/site-suggest-route.test.ts + ingest-site-suggestions.test.ts. The
// unit suites drive the route and the lib against in-memory fakes, which can
// prove the LOGIC but never the SCHEMA: that the `site_suggestions` migration
// really landed, that `user_id` really carries a SET NULL foreign key (the
// requester's account can go while the ops signal stays), that the status
// filter, the `since` cut and the only-`new`-flips rule are real Postgres
// predicates. Those are the facts that would 500 in production while every
// unit test stayed green, so they run here against the REAL prisma client +
// live local Postgres, migrated (the harness/CI runs `prisma migrate deploy`).
//
// Private namespace (a `suggest-itest.example` domain family + one user) that
// no seed row and no other integration file touches; everything is deleted
// after each test so the suite is idempotent and re-runnable.
// A REAL public suffix (.com), unlike the `.example` family the other itests
// use: the route refuses any host whose TLD is not on the Public Suffix List
// (normalizeSuggestedDomain -> resolveStoreDomain), so a `.example` URL would
// 400 here by design. The suffix still namespaces every row this file writes.
const ITEST_DOMAIN_SUFFIX = 'suggest-itest.com'
const USER_EMAIL = 'suggest-itest@example.com'

// Only better-auth and the mail wire are stood in for: a real session needs a
// full sign-in round-trip (WHICH user withRoute resolves is pinned by its own
// tests), and the ops email is a UseSend call. Everything else — prisma, the
// FK, the queries — is real.
const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
}))
vi.mock('@/lib/email', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    sendEmail: sendEmailMock,
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

let userId = ''

function suggest(body: unknown) {
    return POST(
        new NextRequest('http://localhost/api/sites/suggest', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': 'suggest-itest/1.0',
            },
            body: JSON.stringify(body),
        }),
    )
}

async function cleanup() {
    await prisma.siteSuggestion.deleteMany({
        where: { domain: { endsWith: ITEST_DOMAIN_SUFFIX } },
    })
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } })
}

beforeEach(async () => {
    await cleanup()
    const user = await prisma.user.create({
        data: { email: USER_EMAIL, name: 'Suggest Itest', emailVerified: true },
        select: { id: true },
    })
    userId = user.id
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
    sendEmailMock.mockReset()
    sendEmailMock.mockResolvedValue(undefined)
})

afterEach(async () => {
    await cleanup()
})

describe('site_suggestions — real rows, real FK, real queries', () => {
    it('an anonymous suggestion lands as a real `new` row with the normalized domain and no requester', async () => {
        const res = await suggest({
            url: `https://www.Anon.${ITEST_DOMAIN_SUFFIX}/sale`,
        })
        expect(res.status).toBe(200)
        const { id } = (await res.json()) as { id: string }

        const row = await prisma.siteSuggestion.findUniqueOrThrow({
            where: { id },
        })
        expect(row).toMatchObject({
            domain: `anon.${ITEST_DOMAIN_SUFFIX}`,
            rawUrl: `https://www.Anon.${ITEST_DOMAIN_SUFFIX}/sale`,
            userId: null,
            requesterEmail: null,
            source: 'web',
            userAgent: 'suggest-itest/1.0',
            status: 'new',
            importedAt: null,
        })
        expect(row.createdAt).toBeInstanceOf(Date)
    })

    it('a signed-in suggestion is attributed to a REAL user row (the FK holds) with the session email', async () => {
        getSessionMock.mockResolvedValue({
            session: { id: 'itest-session' },
            user: { id: userId, email: USER_EMAIL },
        })
        const res = await suggest({ url: `member.${ITEST_DOMAIN_SUFFIX}` })
        expect(res.status).toBe(200)
        const { id } = (await res.json()) as { id: string }

        const row = await prisma.siteSuggestion.findUniqueOrThrow({
            where: { id },
            include: { user: { select: { email: true } } },
        })
        expect(row.userId).toBe(userId)
        expect(row.requesterEmail).toBe(USER_EMAIL)
        expect(row.user?.email).toBe(USER_EMAIL)
    })

    it('deleting the requester SET NULLs user_id and keeps the row (ops signal survives the account)', async () => {
        getSessionMock.mockResolvedValue({
            session: { id: 'itest-session' },
            user: { id: userId, email: USER_EMAIL },
        })
        const res = await suggest({ url: `orphan.${ITEST_DOMAIN_SUFFIX}` })
        const { id } = (await res.json()) as { id: string }

        await prisma.user.delete({ where: { id: userId } })

        const row = await prisma.siteSuggestion.findUniqueOrThrow({
            where: { id },
        })
        expect(row.userId).toBeNull()
        // TODO(schema): the danger-zone data-delete route does not scrub this
        // yet — see the SiteSuggestion model comment. Pinned as the CURRENT
        // behaviour so the gap is visible, not hidden.
        expect(row.requesterEmail).toBe(USER_EMAIL)
    })

    it('list → ack → list: the pipeline drains `new` oldest-first, the ack flips only those ids, a re-ack counts 0', async () => {
        await suggest({ url: `first.${ITEST_DOMAIN_SUFFIX}` })
        await suggest({ url: `second.${ITEST_DOMAIN_SUFFIX}` })
        await suggest({ url: `third.${ITEST_DOMAIN_SUFFIX}` })

        const listed = (
            await listSiteSuggestions({
                status: 'new',
                limit: 500,
            })
        ).filter(s => s.domain.endsWith(ITEST_DOMAIN_SUFFIX))
        expect(listed.map(s => s.domain)).toEqual([
            `first.${ITEST_DOMAIN_SUFFIX}`,
            `second.${ITEST_DOMAIN_SUFFIX}`,
            `third.${ITEST_DOMAIN_SUFFIX}`,
        ])
        // ISO timestamps on the wire, never Date objects.
        expect(listed[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)

        const firstTwo = listed.slice(0, 2).map(s => s.id)
        expect(await acknowledgeSiteSuggestions(firstTwo)).toEqual({
            acknowledged: 2,
        })
        expect(await acknowledgeSiteSuggestions(firstTwo)).toEqual({
            acknowledged: 0,
        })

        const remaining = (
            await listSiteSuggestions({
                status: 'new',
                limit: 500,
            })
        ).filter(s => s.domain.endsWith(ITEST_DOMAIN_SUFFIX))
        expect(remaining.map(s => s.domain)).toEqual([
            `third.${ITEST_DOMAIN_SUFFIX}`,
        ])

        const imported = (
            await listSiteSuggestions({
                status: 'imported',
                limit: 500,
            })
        ).filter(s => s.domain.endsWith(ITEST_DOMAIN_SUFFIX))
        expect(new Set(imported.map(s => s.id))).toEqual(new Set(firstTwo))
        const stamped = await prisma.siteSuggestion.findMany({
            where: { id: { in: firstTwo } },
            select: { importedAt: true },
        })
        expect(stamped.every(r => r.importedAt instanceof Date)).toBe(true)
    })

    it('`since` is a real timestamp predicate on created_at', async () => {
        await suggest({ url: `old.${ITEST_DOMAIN_SUFFIX}` })
        const cut = new Date()
        // created_at is TIMESTAMP(3): step past the millisecond the cut landed
        // in so the second row is strictly after it.
        await new Promise(resolve => setTimeout(resolve, 10))
        await suggest({ url: `fresh.${ITEST_DOMAIN_SUFFIX}` })

        const after = (
            await listSiteSuggestions({
                status: 'new',
                since: new Date(cut.getTime() + 1).toISOString(),
                limit: 500,
            })
        ).filter(s => s.domain.endsWith(ITEST_DOMAIN_SUFFIX))
        expect(after.map(s => s.domain)).toEqual([
            `fresh.${ITEST_DOMAIN_SUFFIX}`,
        ])
    })
})
