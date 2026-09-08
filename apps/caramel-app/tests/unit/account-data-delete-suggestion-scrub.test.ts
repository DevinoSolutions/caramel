import { POST as deletePOST } from '@/app/api/account/data/delete/route'
import { POST as notifyPOST } from '@/app/api/ingest/site-suggestions/notify/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    matchesWhere,
    resetTable,
    seedRow,
    siteSuggestionFake,
    table,
} from './support/siteSuggestionsPrismaFake'

// "Delete my data" and the requester identity on site_suggestions.
//
// The row is SCRUBBED, not deleted: a "please support this store" request is
// not personal data once the requester is off it, and it is the coupons
// pipeline's input — deleting it would silently retract a store request other
// people may also have made.
//
// The bug this file exists to keep fixed is the SIGNED-OUT suggestion. That row
// carries no user id at all: the address the visitor typed is the only thing on
// it. A scrub matched on `user_id` alone is the fix that looks right and leaves
// behind exactly the email the route was written to remove — so the pair below
// keeps both losing predicates verbatim and runs them against the same rows.
//
// ANNOUNCED FAKE, but an EXECUTING one: `$transaction` really awaits the batch
// and `siteSuggestion.updateMany` really evaluates the where against an
// in-memory table (support/siteSuggestionsPrismaFake.ts). A recording-only mock
// could not tell a matching predicate from a missing one, which is the whole
// question here. The case-insensitive match is Postgres behaviour imitated in
// that fake and pinned for real in tests/integration/site-suggestions.itest.ts.

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        $transaction: vi.fn(async (ops: Promise<unknown>[]) =>
            Promise.all(ops),
        ),
        savingsEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        favoriteStore: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        couponReport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        user: { update: vi.fn(), delete: vi.fn() },
        siteSuggestion: {} as Record<string, unknown>,
    },
}))
vi.mock('@/lib/prisma', async () => {
    const fake = await import('./support/siteSuggestionsPrismaFake')
    prismaMock.siteSuggestion = fake.siteSuggestionFake as unknown as Record<
        string,
        unknown
    >
    return { default: prismaMock }
})

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

const { envMock } = vi.hoisted(() => ({
    envMock: {
        INGEST_API_KEY: 'test-ingest-key-scrub',
        SITE_SUGGESTIONS_AUTO_NOTIFY: 'false',
        ALLOWED_ORIGINS: '',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
}))
vi.mock('@/lib/email', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    sendEmail: sendEmailMock,
}))

const USER_ID = 'user-under-test'
const USER_EMAIL = 'shopper@example.com'

function deleteRequest(body: unknown = { confirm: 'DELETE' }) {
    return new NextRequest('http://localhost/api/account/data/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

function notifyRequest(ids: string[]) {
    return new NextRequest(
        'http://localhost/api/ingest/site-suggestions/notify',
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${envMock.INGEST_API_KEY}`,
            },
            body: JSON.stringify({ ids }),
        },
    )
}

function row(id: string) {
    return table.find(r => r.id === id)!
}

/** The three rows every case below needs: one made while signed IN, one made
 * while signed OUT (email only, and typed in a different case), and one
 * belonging to somebody else entirely. */
function seedTheThreeRows() {
    seedRow('signed-in', {
        domain: 'worldofbooks.com',
        userId: USER_ID,
        requesterEmail: USER_EMAIL,
        userAgent: 'Mozilla/5.0 (their laptop)',
    })
    seedRow('signed-out', {
        domain: 'peepers.com',
        userId: null,
        // What they TYPED — the account's own spelling is lower case.
        requesterEmail: 'Shopper@Example.COM',
        userAgent: 'Mozilla/5.0 (their phone)',
    })
    seedRow('somebody-else', {
        domain: 'worldofbooks.com',
        userId: 'a-different-user',
        requesterEmail: 'stranger@example.com',
        userAgent: 'Mozilla/5.0 (not theirs)',
    })
}

beforeEach(() => {
    resetTable()
    sendEmailMock.mockClear()
    prismaMock.$transaction.mockClear()
    prismaMock.savingsEvent.deleteMany.mockClear()
    prismaMock.favoriteStore.deleteMany.mockClear()
    prismaMock.couponReport.deleteMany.mockClear()
    getSessionMock.mockResolvedValue({
        user: { id: USER_ID, email: USER_EMAIL },
    })
})

describe('delete-my-data scrubs the requester identity — THE PAIR', () => {
    it('the PRE-CHANGE route touched no suggestion at all, so both of the caller’s rows kept their email', async () => {
        seedTheThreeRows()
        // The transaction the route ran before this change, kept VERBATIM.
        await prismaMock.$transaction([
            prismaMock.savingsEvent.deleteMany(),
            prismaMock.favoriteStore.deleteMany(),
            prismaMock.couponReport.deleteMany(),
        ])

        expect(row('signed-in').requesterEmail).toBe(USER_EMAIL)
        expect(row('signed-out').requesterEmail).toBe('Shopper@Example.COM')
    })

    it('the NAIVE fix — matching on user_id alone — leaves the signed-out row’s email in place', async () => {
        seedTheThreeRows()
        // The predicate everybody writes first, kept VERBATIM and run against
        // the same rows through the same fake.
        await siteSuggestionFake.updateMany({
            where: { userId: USER_ID },
            data: {
                userId: null,
                requesterEmail: null,
                userAgent: null,
                rawUrl: '',
            },
        })

        expect(row('signed-in').requesterEmail).toBeNull()
        // ...and here is the address the route exists to remove, still there.
        expect(row('signed-out').requesterEmail).toBe('Shopper@Example.COM')
    })

    it('the SHIPPED route scrubs BOTH — the user_id-matched row and the email-only one', async () => {
        seedTheThreeRows()
        const res = await deletePOST(deleteRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            deleted: {
                savingsEvents: 0,
                favoriteStores: 0,
                couponReports: 0,
            },
            // Its own key: these rows still exist. Calling it a deletion would
            // be a lie the next reader of this response would believe.
            scrubbed: { siteSuggestions: 2 },
        })
        for (const id of ['signed-in', 'signed-out']) {
            expect(row(id).userId).toBeNull()
            expect(row(id).requesterEmail).toBeNull()
            expect(row(id).userAgent).toBeNull()
            // A pasted URL can carry a session or affiliate token, and the
            // pipeline only ever keys on `domain`. Emptied, not nulled: the
            // column is NOT NULL and `rawUrl` is a required string on the wire
            // the coupons repo reads.
            expect(row(id).rawUrl).toBe('')
        }
    })
})

describe('delete-my-data scrubs the requester identity — scope', () => {
    it('a third user’s suggestion is untouched, identity and all', async () => {
        seedTheThreeRows()
        await deletePOST(deleteRequest())

        expect(row('somebody-else')).toMatchObject({
            userId: 'a-different-user',
            requesterEmail: 'stranger@example.com',
            userAgent: 'Mozilla/5.0 (not theirs)',
            rawUrl: 'https://www.somebody-else.example.com/',
        })
    })

    it('the store request SURVIVES: domain, status and created_at are left alone, the pasted URL is not, and nothing new is stamped', async () => {
        seedRow('signed-in', {
            domain: 'worldofbooks.com',
            status: 'supported',
            userId: USER_ID,
            requesterEmail: USER_EMAIL,
        })
        const before = { ...row('signed-in') }
        await deletePOST(deleteRequest())

        const after = row('signed-in')
        expect(after.domain).toBe('worldofbooks.com')
        expect(after.status).toBe('supported')
        // rawUrl does NOT survive — it is what the person pasted, not the
        // request. `domain` is the whole of what the pipeline needs.
        expect(before.rawUrl).not.toBe('')
        expect(after.rawUrl).toBe('')
        expect(after.createdAt).toEqual(before.createdAt)
        // A scrub is not an ANSWER to the request, so it dates nothing.
        expect(after.statusChangedAt).toBeNull()
        expect(after.notifiedAt).toBeNull()
        expect(after.importedAt).toBeNull()
    })

    it('an account with NO email contributes no email branch — it can never match every anonymous suggestion', async () => {
        seedRow('mine', { userId: USER_ID, requesterEmail: null })
        seedRow('anonymous-stranger', {
            userId: null,
            requesterEmail: null,
            userAgent: 'somebody else entirely',
        })
        getSessionMock.mockResolvedValue({
            user: { id: USER_ID, email: null },
        })

        const res = await deletePOST(deleteRequest())
        expect((await res.json()).scrubbed).toEqual({ siteSuggestions: 1 })
        expect(row('anonymous-stranger').userAgent).toBe(
            'somebody else entirely',
        )
    })

    it('an empty OR would match NOTHING, not everything — the failure mode a conditional where must not have', () => {
        // Guards the fake's own semantics, which the pins above rest on: if an
        // empty OR matched every row, "the scrub is correctly scoped" would be
        // unfalsifiable here.
        seedRow('any')
        expect(matchesWhere(row('any'), { OR: [] })).toBe(false)
    })
})

describe('delete-my-data scrubs the requester identity — transactional', () => {
    it('the scrub is the FOURTH member of the SAME batch, never a loose await after it', async () => {
        seedTheThreeRows()
        await deletePOST(deleteRequest())

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
        const batch = prismaMock.$transaction.mock.calls[0]![0]
        expect(Array.isArray(batch)).toBe(true)
        expect(batch).toHaveLength(4)
        expect(siteSuggestionFake.updateMany).toHaveBeenCalledTimes(1)
    })

    it('a failing batch scrubs NOTHING — the email cannot be left behind by a partial run', async () => {
        seedTheThreeRows()
        prismaMock.$transaction.mockRejectedValueOnce(
            new Error('deadlock detected on favorite_stores'),
        )

        const res = await deletePOST(deleteRequest())
        expect(res.status).toBe(500)
        // The route builds the batch before handing it over, so the operation
        // object exists; what must NOT have happened is the row changing.
        expect(row('signed-in').requesterEmail).toBe(USER_EMAIL)
        expect(row('signed-out').requesterEmail).toBe('Shopper@Example.COM')
    })
})

describe('a scrubbed suggestion still behaves — the notify route', () => {
    it('a scrubbed `supported` row is `not_eligible` for want of an email, never a crash', async () => {
        seedRow('was-theirs', {
            domain: 'worldofbooks.com',
            status: 'supported',
            userId: USER_ID,
            requesterEmail: USER_EMAIL,
        })
        await deletePOST(deleteRequest())
        expect(row('was-theirs').requesterEmail).toBeNull()

        const res = await notifyPOST(notifyRequest(['was-theirs']))
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
            ok: true,
            sent: 0,
            notEligible: 1,
            results: [
                {
                    id: 'was-theirs',
                    outcome: 'not_eligible',
                    reason: 'no_email',
                },
            ],
        })
        // The person asked to be forgotten. Nothing may be mailed to them.
        expect(sendEmailMock).not.toHaveBeenCalled()
    })
})
