import { POST as deleteMyData } from '@/app/api/account/data/delete/route'
import { POST } from '@/app/api/sites/suggest/route'
import prisma from '@/lib/prisma'
import { siteSuggestionIdentityWhere } from '@/lib/siteSuggestionIdentity'
import {
    listSiteSuggestions,
    notifySupportedRequesters,
    siteSuggestionAutoNotifyEnabled,
    transitionSiteSuggestions,
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
        const acked = await transitionSiteSuggestions(firstTwo, 'imported')
        expect(new Set(acked.changed)).toEqual(new Set(firstTwo))
        const reAcked = await transitionSiteSuggestions(firstTwo, 'imported')
        expect(reAcked.changed).toEqual([])
        expect(reAcked.refused.map(r => r.reason)).toEqual([
            'already',
            'already',
        ])

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

// The status/notice half (#226). These are the facts the in-memory fake in
// tests/unit cannot judge, because they are properties of the SCHEMA and of
// Postgres, not of our TypeScript: that the `status_changed_at`/`notified_at`
// columns really landed, that the allowed-source guard in the transition's
// WHERE clause is a real predicate the database enforces, and that the
// `notified_at IS NULL` claim really serialises a send.
async function createRow(
    domain: string,
    overrides: {
        status?: string
        requesterEmail?: string | null
        notifiedAt?: Date | null
    } = {},
): Promise<string> {
    const created = await prisma.siteSuggestion.create({
        data: {
            domain,
            rawUrl: `https://${domain}/`,
            source: 'web',
            status: overrides.status ?? 'new',
            requesterEmail: overrides.requesterEmail ?? null,
            notifiedAt: overrides.notifiedAt ?? null,
        },
        select: { id: true },
    })
    return created.id
}

describe('site suggestions — answering a request (real Postgres)', () => {
    it('the migration really added status_changed_at and notified_at, and a transition stamps the first', async () => {
        const id = await createRow(`marks.${ITEST_DOMAIN_SUFFIX}`)
        const result = await transitionSiteSuggestions([id], 'unsupported')
        expect(result.changed).toEqual([id])

        const row = await prisma.siteSuggestion.findUniqueOrThrow({
            where: { id },
            select: {
                status: true,
                statusChangedAt: true,
                importedAt: true,
                notifiedAt: true,
            },
        })
        expect(row.status).toBe('unsupported')
        expect(row.statusChangedAt).toBeInstanceOf(Date)
        // importedAt dates the pipeline's first hand-over only — a `unsupported`
        // answer must not invent one.
        expect(row.importedAt).toBeNull()
        expect(row.notifiedAt).toBeNull()
    })

    it('THE PAIR: the closed-row guard is enforced by the DATABASE, not by the read before it', async () => {
        const id = await createRow(`closed.${ITEST_DOMAIN_SUFFIX}`, {
            status: 'supported',
        })

        // The guard lives in the UPDATE's own WHERE clause, so even a caller
        // that reached it with a stale reading of the row cannot move it.
        const direct = await prisma.siteSuggestion.updateMany({
            where: { id, status: { in: ['new'] } },
            data: { status: 'imported' },
        })
        expect(direct.count).toBe(0)

        const refused = await transitionSiteSuggestions([id], 'imported')
        expect(refused.changed).toEqual([])
        expect(refused.refused).toEqual([
            { id, from: 'supported', reason: 'backwards' },
        ])
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id },
                select: { status: true },
            }),
        ).resolves.toEqual({ status: 'supported' })

        // ...while a terminal-to-terminal answer really does move it.
        const moved = await transitionSiteSuggestions([id], 'unsupported')
        expect(moved.changed).toEqual([id])
    })

    it('a `supported` ack with the switch OFF marks the row and mails NOBODY', async () => {
        // Read from the REAL env module (this config loads the package .env):
        // if a machine has turned the switch on, say so plainly instead of
        // failing later on a count that looks unexplained.
        expect(
            siteSuggestionAutoNotifyEnabled(),
            'SITE_SUGGESTIONS_AUTO_NOTIFY must be off (its default) for this test',
        ).toBe(false)
        const id = await createRow(`quiet.${ITEST_DOMAIN_SUFFIX}`, {
            requesterEmail: USER_EMAIL,
        })
        const result = await transitionSiteSuggestions([id], 'supported')
        expect(result.notifiedSent).toBe(0)
        expect(result.notifiedPending).toBe(1)
        expect(sendEmailMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ to: USER_EMAIL }),
        )
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id },
                select: { notifiedAt: true },
            }),
        ).resolves.toEqual({ notifiedAt: null })
    })

    it('the notifier claims notified_at BEFORE sending, so a real second call cannot re-send', async () => {
        const id = await createRow(`told.${ITEST_DOMAIN_SUFFIX}`, {
            status: 'supported',
            requesterEmail: USER_EMAIL,
        })
        const first = await notifySupportedRequesters([id])
        expect(first.sent).toBe(1)
        const stamped = await prisma.siteSuggestion.findUniqueOrThrow({
            where: { id },
            select: { notifiedAt: true },
        })
        expect(stamped.notifiedAt).toBeInstanceOf(Date)

        const second = await notifySupportedRequesters([id])
        expect(second.sent).toBe(0)
        expect(second.alreadyNotified).toBe(1)
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id },
                select: { notifiedAt: true },
            }),
        ).resolves.toEqual(stamped)
    })

    it('one mail per requester email per domain — a duplicate row is stamped, never mailed again', async () => {
        const domain = `dupe.${ITEST_DOMAIN_SUFFIX}`
        const first = await createRow(domain, {
            status: 'supported',
            requesterEmail: USER_EMAIL,
        })
        await notifySupportedRequesters([first])
        const toldAt = (
            await prisma.siteSuggestion.findUniqueOrThrow({
                where: { id: first },
                select: { notifiedAt: true },
            })
        ).notifiedAt
        sendEmailMock.mockClear()

        // The same person asking for the same store again, later.
        const again = await createRow(domain, {
            status: 'supported',
            requesterEmail: USER_EMAIL.toUpperCase(),
        })
        const result = await notifySupportedRequesters([again])
        expect(result.sent).toBe(0)
        expect(result.alreadyNotified).toBe(1)
        expect(sendEmailMock).not.toHaveBeenCalled()
        // Stamped with the instant they were ACTUALLY told.
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id: again },
                select: { notifiedAt: true },
            }),
        ).resolves.toEqual({ notifiedAt: toldAt })
    })
})

// "Delete my data" and the requester identity (#227), on real Postgres.
//
// The unit suite imitates `mode: 'insensitive'` in its in-memory fake. Whether
// Postgres actually folds the case — and whether the OR really reaches a row
// that carries no user id at all — is a property of the database, so it is
// settled here.
describe('delete-my-data scrubs the requester identity (real Postgres)', () => {
    it('scrubs the signed-in row AND the email-only row typed in a different case, and leaves a third user alone', async () => {
        const mine = await createRow(`mine.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id: mine },
            data: {
                userId,
                requesterEmail: USER_EMAIL,
                userAgent: 'their laptop',
            },
        })
        // Made while SIGNED OUT: no user id, and the address as THEY typed it.
        const anonymous = await createRow(`anon.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id: anonymous },
            data: {
                requesterEmail: USER_EMAIL.toUpperCase(),
                userAgent: 'their phone',
            },
        })
        const stranger = await createRow(`stranger.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id: stranger },
            data: {
                requesterEmail: `someone-else@${ITEST_DOMAIN_SUFFIX}`,
                userAgent: 'not theirs',
            },
        })

        getSessionMock.mockResolvedValue({
            user: { id: userId, email: USER_EMAIL },
        })
        const res = await deleteMyData(
            new NextRequest('http://localhost/api/account/data/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: 'DELETE' }),
            }),
        )
        expect(res.status).toBe(200)
        expect((await res.json()).scrubbed).toEqual({ siteSuggestions: 2 })

        for (const id of [mine, anonymous]) {
            await expect(
                prisma.siteSuggestion.findUniqueOrThrow({
                    where: { id },
                    select: {
                        userId: true,
                        requesterEmail: true,
                        userAgent: true,
                        rawUrl: true,
                    },
                }),
            ).resolves.toEqual({
                userId: null,
                requesterEmail: null,
                userAgent: null,
                // A pasted URL can carry a session or affiliate token. Emptied,
                // not nulled: the column is NOT NULL and `rawUrl` is a required
                // string on the wire the coupons pipeline reads.
                rawUrl: '',
            })
        }
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id: stranger },
                select: { requesterEmail: true, userAgent: true },
            }),
        ).resolves.toEqual({
            requesterEmail: `someone-else@${ITEST_DOMAIN_SUFFIX}`,
            userAgent: 'not theirs',
        })
    })

    it('the store request itself survives the scrub, and stays drainable by the pipeline', async () => {
        const id = await createRow(`survives.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id },
            data: { userId, requesterEmail: USER_EMAIL },
        })
        getSessionMock.mockResolvedValue({
            user: { id: userId, email: USER_EMAIL },
        })
        await deleteMyData(
            new NextRequest('http://localhost/api/account/data/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: 'DELETE' }),
            }),
        )

        // Still a `new` row the pipeline will hand out, with its domain intact.
        const listed = (
            await listSiteSuggestions({ status: 'new', limit: 500 })
        ).filter(s => s.id === id)
        expect(listed).toHaveLength(1)
        expect(listed[0]).toMatchObject({
            domain: `survives.${ITEST_DOMAIN_SUFFIX}`,
            requesterEmail: null,
            status: 'new',
            // The store request is the DOMAIN; the URL the person pasted is not
            // part of it and does not survive.
            rawUrl: '',
        })
    })
})

// The danger-zone gate reads a COUNT from GET /api/account/overview, and it
// must be the same population the scrub touches: if the two predicates ever
// disagreed, the page would say "Nothing to delete" about rows the delete route
// would happily have scrubbed. Both call siteSuggestionIdentityWhere, so this
// pins the round trip rather than the spelling — including the part only
// Postgres can settle, that `mode: 'insensitive'` really folds the case.
describe('the danger-zone count and the scrub agree (real Postgres)', () => {
    async function identifyingCount(): Promise<number> {
        return prisma.siteSuggestion.count({
            where: {
                AND: [
                    siteSuggestionIdentityWhere({
                        userId,
                        email: USER_EMAIL,
                    }),
                    { domain: { endsWith: ITEST_DOMAIN_SUFFIX } },
                ],
            },
        })
    }

    it('counts the signed-out, email-only request, then counts NOTHING once it is scrubbed', async () => {
        const anonymous = await createRow(`gate.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id: anonymous },
            data: { requesterEmail: USER_EMAIL.toUpperCase() },
        })
        // The account's ONLY personal data. Before the gate counted these, this
        // user read "Nothing to delete" and could never reach the route.
        expect(await identifyingCount()).toBe(1)

        getSessionMock.mockResolvedValue({
            user: { id: userId, email: USER_EMAIL },
        })
        await deleteMyData(
            new NextRequest('http://localhost/api/account/data/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: 'DELETE' }),
            }),
        )

        // The row still exists, and nothing on it identifies this account any
        // more — so the button goes back to "Nothing to delete" by itself. No
        // second "has anything left to scrub" condition is needed for that:
        // every branch of the predicate requires a non-null column.
        expect(await identifyingCount()).toBe(0)
        await expect(
            prisma.siteSuggestion.findUniqueOrThrow({
                where: { id: anonymous },
                select: { domain: true },
            }),
        ).resolves.toEqual({ domain: `gate.${ITEST_DOMAIN_SUFFIX}` })
    })

    it('a request that belongs to NOBODY — no user id, no email, only a user agent — is never counted', async () => {
        const orphan = await createRow(`orphan.${ITEST_DOMAIN_SUFFIX}`)
        await prisma.siteSuggestion.update({
            where: { id: orphan },
            data: { userAgent: 'somebody else entirely' },
        })
        expect(await identifyingCount()).toBe(0)
    })
})
