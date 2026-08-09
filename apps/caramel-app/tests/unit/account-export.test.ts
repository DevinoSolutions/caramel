// Static import — vitest hoists the vi.mock calls below above it. A top-level
// `await import` would trip TS1378 under this tsconfig.
import { GET } from '@/app/api/account/export/route'
import {
    buildAccountExport,
    collectForbiddenKeys,
    exportFilename,
    type AccountExport,
} from '@/lib/profile/accountExport'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/account/export — "Download your data".
//
// The never-include list is the point of this file. This is a PUBLIC repo and
// the endpoint hands a user a file built from their own User row, which carries
// `password`, `token` and `tokenExpiry` — a bare `findUnique` would have put
// all three in the download. The guard is asserted three ways: the walker
// itself, the built payload, and the route's actual response body.

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        user: { findUnique: vi.fn() },
        favoriteStore: { findMany: vi.fn() },
        savingsEvent: { findMany: vi.fn() },
        couponReport: { findMany: vi.fn() },
    },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

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

const USER_ID = 'user-under-test'
const CREATED_AT = new Date('2026-03-14T10:00:00.000Z')

function exportRequest() {
    return new NextRequest('http://localhost/api/account/export', {
        method: 'GET',
    })
}

const ACCOUNT_ROW = {
    id: USER_ID,
    email: 'shopper@example.com',
    name: 'Sam Shopper',
    firstName: 'Sam',
    lastName: 'Shopper',
    username: 'sam',
    createdAt: CREATED_AT,
    emailVerified: true,
}

beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockResolvedValue({ user: { id: USER_ID } })
    prismaMock.user.findUnique.mockResolvedValue(ACCOUNT_ROW)
    prismaMock.favoriteStore.findMany.mockResolvedValue([
        {
            storeName: 'nike.com',
            createdAt: new Date('2026-05-01T00:00:00.000Z'),
        },
    ])
    prismaMock.savingsEvent.findMany.mockResolvedValue([
        {
            store: 'nike.com',
            code: 'SAVE10',
            amountCents: 700,
            currency: 'USD',
            occurredAt: new Date('2026-06-01T12:00:00.000Z'),
        },
        {
            store: 'gap.com',
            code: '',
            amountCents: 800,
            currency: 'USD',
            occurredAt: new Date('2026-05-20T12:00:00.000Z'),
        },
    ])
    prismaMock.couponReport.findMany.mockResolvedValue([
        {
            outcome: 'failed',
            createdAt: new Date('2026-05-10T12:00:00.000Z'),
            coupon: { site: 'gap.com', code: 'NOPE20' },
        },
    ])
})

describe('collectForbiddenKeys — the never-include walker', () => {
    it('a clean payload has no violations', () => {
        expect(collectForbiddenKeys({ account: { email: 'a@b.c' } })).toEqual(
            [],
        )
    })

    it('catches credential material at any depth, case-insensitively', () => {
        expect(
            collectForbiddenKeys({ account: { PasswordHash: 'x' } }),
        ).toContain('account.PasswordHash')
        expect(collectForbiddenKeys({ a: { b: { token: 't' } } })).toContain(
            'a.b.token',
        )
        expect(
            collectForbiddenKeys({ oauth: { refresh_token: 'r' } }),
        ).toContain('oauth.refresh_token')
    })

    it('catches internal row ids while allowing the account id the export exists to carry', () => {
        expect(collectForbiddenKeys({ account: { id: 'u1' } })).toEqual([])
        expect(
            collectForbiddenKeys({ savingsEvents: [{ id: 'evt_1' }] }),
        ).toContain('savingsEvents[].id')
        expect(
            collectForbiddenKeys({ couponReports: [{ couponId: 'c1' }] }),
        ).toContain('couponReports[].couponId')
    })

    it('collapses array indices so a 400-row export reports a violation ONCE', () => {
        const hits = collectForbiddenKeys({
            savingsEvents: Array.from({ length: 400 }, () => ({
                couponId: 'c1',
            })),
        })
        expect(hits).toEqual(['savingsEvents[].couponId'])
    })

    it("catches another user's identifier leaking in as userId", () => {
        expect(
            collectForbiddenKeys({ favoriteStores: [{ userId: 'someone' }] }),
        ).toContain('favoriteStores[].userId')
    })
})

describe('buildAccountExport — the shape', () => {
    it('produces the documented contract and drops every internal key on the way through', () => {
        const payload = buildAccountExport(
            {
                account: ACCOUNT_ROW,
                savingsSyncEnabled: false,
                favoriteStores: [
                    {
                        storeName: 'nike.com',
                        createdAt: new Date('2026-05-01T00:00:00.000Z'),
                    },
                ],
                savingsEvents: [
                    {
                        store: 'nike.com',
                        code: 'SAVE10',
                        amountCents: 700,
                        currency: 'USD',
                        occurredAt: new Date('2026-06-01T12:00:00.000Z'),
                    },
                ],
                couponReports: [
                    {
                        outcome: 'failed',
                        createdAt: new Date('2026-05-10T12:00:00.000Z'),
                        coupon: { site: 'gap.com', code: 'NOPE20' },
                    },
                ],
            },
            new Date('2026-08-09T14:03:00.000Z'),
        )

        expect(payload).toEqual({
            exportedAt: '2026-08-09T14:03:00.000Z',
            account: {
                id: USER_ID,
                email: 'shopper@example.com',
                name: 'Sam Shopper',
                firstName: 'Sam',
                lastName: 'Shopper',
                username: 'sam',
                createdAt: CREATED_AT.toISOString(),
                emailVerified: true,
            },
            preferences: { savingsSyncEnabled: false },
            favoriteStores: [
                { domain: 'nike.com', starredAt: '2026-05-01T00:00:00.000Z' },
            ],
            savingsEvents: [
                {
                    storeDomain: 'nike.com',
                    code: 'SAVE10',
                    amountMinorUnits: 700,
                    currency: 'USD',
                    occurredAt: '2026-06-01T12:00:00.000Z',
                },
            ],
            couponReports: [
                {
                    // Named by what the user SAW, never by the catalog row id.
                    storeDomain: 'gap.com',
                    code: 'NOPE20',
                    outcome: 'failed',
                    reportedAt: '2026-05-10T12:00:00.000Z',
                },
            ],
        })
    })

    it('a report whose coupon row is gone still exports, with nulls rather than a crash', () => {
        const payload = buildAccountExport({
            account: ACCOUNT_ROW,
            savingsSyncEnabled: false,
            favoriteStores: [],
            savingsEvents: [],
            couponReports: [
                {
                    outcome: 'worked',
                    createdAt: new Date('2026-05-10T12:00:00.000Z'),
                    coupon: null,
                },
            ],
        })
        expect(payload.couponReports[0]).toMatchObject({
            storeDomain: null,
            code: null,
        })
    })

    it('names the file by date', () => {
        expect(exportFilename(new Date('2026-08-09T23:59:00.000Z'))).toBe(
            'caramel-data-2026-08-09.json',
        )
    })
})

describe('GET /api/account/export', () => {
    it('returns the payload as a downloadable attachment that no cache may store', async () => {
        const res = await GET(exportRequest())

        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Disposition')).toMatch(
            /^attachment; filename="caramel-data-\d{4}-\d{2}-\d{2}\.json"$/,
        )
        expect(res.headers.get('Cache-Control')).toBe('no-store')
        expect(res.headers.get('Content-Type')).toContain('application/json')
    })

    it('the ACTUAL response body carries nothing from the never-include list', async () => {
        const res = await GET(exportRequest())

        // A NEGATIVE assertion is only as good as its proof that it is looking
        // at the real thing. "No forbidden keys" is trivially satisfied by an
        // empty body, an error body, a 404, or a typo'd URL — every one of
        // which is a failure this test exists to catch. So the positive half
        // comes FIRST and is what gives the negative half meaning: this is not
        // "no secrets leaked", it is "no secrets leaked, in a response that
        // definitely contained the data secrets could have leaked from".
        expect(res.status).toBe(200)
        const body = (await res.json()) as AccountExport

        expect(body.account.email).toBe('shopper@example.com')
        expect(body.account.id).toBe(USER_ID)
        expect(body.savingsEvents.length).toBeGreaterThan(0)
        expect(body.favoriteStores.length).toBeGreaterThan(0)
        expect(body.couponReports.length).toBeGreaterThan(0)
        // The account row this export is built FROM is the one carrying
        // password/token, so a populated account block is the specific proof
        // that the walker below had something dangerous to find.
        expect(Object.keys(body.account).length).toBeGreaterThan(5)

        // Only now does absence mean anything.
        expect(collectForbiddenKeys(body)).toEqual([])

        // Belt and braces against the walker itself being wrong: the three
        // User columns that must never travel, checked by name in the raw text.
        const raw = JSON.stringify(body)
        expect(raw).not.toContain('password')
        expect(raw).not.toContain('tokenExpiry')
        expect(raw).not.toContain('"token"')
    })

    it('selects User columns EXPLICITLY — a bare findUnique would export password + token', async () => {
        await GET(exportRequest())
        const args = prismaMock.user.findUnique.mock.calls[0]![0]
        expect(args.select).toBeDefined()
        expect(args.select).not.toHaveProperty('password')
        expect(args.select).not.toHaveProperty('token')
        expect(args.select).not.toHaveProperty('tokenExpiry')
    })

    it('scopes every collection query to the calling user', async () => {
        await GET(exportRequest())
        for (const model of [
            prismaMock.favoriteStore.findMany,
            prismaMock.savingsEvent.findMany,
            prismaMock.couponReport.findMany,
        ]) {
            expect(model).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: USER_ID } }),
            )
        }
    })

    it('the preferences block reflects the users table, not the session', async () => {
        // Same custom-column trap as the overview: a session cannot be trusted
        // to carry savingsSyncEnabled, so the export reads it from the row.
        getSessionMock.mockResolvedValue({
            user: { id: USER_ID, savingsSyncEnabled: false },
            session: { id: 'sess' },
        })
        prismaMock.user.findUnique.mockResolvedValue({
            ...ACCOUNT_ROW,
            savingsSyncEnabled: true,
        })

        const body = (await (
            await GET(exportRequest())
        ).json()) as AccountExport
        expect(body.preferences).toEqual({ savingsSyncEnabled: true })
    })

    it('an anonymous caller gets 401 and nothing is read', async () => {
        getSessionMock.mockResolvedValue(null)
        const res = await GET(exportRequest())

        expect(res.status).toBe(401)
        expect(prismaMock.savingsEvent.findMany).not.toHaveBeenCalled()
    })

    it('a live session whose user row is gone is a 404, not a file with a null account', async () => {
        prismaMock.user.findUnique.mockResolvedValue(null)
        const res = await GET(exportRequest())
        expect(res.status).toBe(404)
    })

    it('an empty account exports empty collections, not a malformed file', async () => {
        prismaMock.favoriteStore.findMany.mockResolvedValue([])
        prismaMock.savingsEvent.findMany.mockResolvedValue([])
        prismaMock.couponReport.findMany.mockResolvedValue([])

        const body = (await (
            await GET(exportRequest())
        ).json()) as AccountExport
        expect(body.favoriteStores).toEqual([])
        expect(body.savingsEvents).toEqual([])
        expect(body.couponReports).toEqual([])
        expect(body.account.id).toBe(USER_ID)
    })
})
