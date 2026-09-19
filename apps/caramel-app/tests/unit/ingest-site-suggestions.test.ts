import { POST as ackPOST } from '@/app/api/ingest/site-suggestions/ack/route'
import { GET as listGET } from '@/app/api/ingest/site-suggestions/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit pins for the coupons pipeline's read/ack door onto site_suggestions —
// the HTTP contract on top of src/lib/siteSuggestions.ts: the apiKey:'ingest'
// bearer gate (INGEST_API_KEY, fail-closed when unset, same as ingest/catalog),
// the query/body validation, the exact wire shape the other repo consumes, and
// the new -> imported flip. The SQL half (a real findMany/updateMany against
// Postgres) is covered by tests/integration/site-suggestions.itest.ts.
//
// ANNOUNCED FAKE: prisma's siteSuggestion.findMany / updateMany are backed by a
// tiny in-memory table that honours the where/orderBy/take the lib sends, so
// the status filter, the `since` cut and the only-`new`-flips rule are
// genuinely exercised rather than asserted from a canned return value.
const { envMock } = vi.hoisted(() => ({
    envMock: { INGEST_API_KEY: undefined as string | undefined },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { prismaMock, table } = vi.hoisted(() => {
    interface Row {
        id: string
        domain: string
        rawUrl: string
        userId: string | null
        requesterEmail: string | null
        source: string
        userAgent: string | null
        status: string
        createdAt: Date
        importedAt: Date | null
    }
    const rows: Row[] = []
    return {
        table: rows,
        prismaMock: {
            siteSuggestion: {
                findMany: vi.fn(
                    async (args: {
                        where: { status: string; createdAt?: { gte: Date } }
                        orderBy: { createdAt: 'asc' }
                        take: number
                        select: Record<string, true>
                    }) => {
                        const since = args.where.createdAt?.gte
                        // Oldest-first, honouring `orderBy` — an insertion
                        // sort rather than Array#sort (the tsconfig lib
                        // predates toSorted, and sort() mutates the table).
                        const ordered: Row[] = []
                        for (const row of rows) {
                            if (row.status !== args.where.status) continue
                            if (since && row.createdAt < since) continue
                            const after = ordered.findIndex(
                                r => r.createdAt > row.createdAt,
                            )
                            if (after === -1) ordered.push(row)
                            else ordered.splice(after, 0, row)
                        }
                        return ordered.slice(0, args.take).map(row => {
                            const picked: Record<string, unknown> = {}
                            for (const key of Object.keys(args.select)) {
                                picked[key] = row[key as keyof Row]
                            }
                            return picked
                        })
                    },
                ),
                updateMany: vi.fn(
                    async (args: {
                        where: { id: { in: string[] }; status: string }
                        data: { status: string; importedAt: Date }
                    }) => {
                        let count = 0
                        for (const row of rows) {
                            if (
                                args.where.id.in.includes(row.id) &&
                                row.status === args.where.status
                            ) {
                                row.status = args.data.status
                                row.importedAt = args.data.importedAt
                                count += 1
                            }
                        }
                        return { count }
                    },
                ),
            },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const INGEST_KEY = 'test-ingest-key-suggestions'

function seed(
    id: string,
    createdAt: string,
    overrides: Partial<(typeof table)[number]> = {},
) {
    table.push({
        id,
        domain: `${id}.example`,
        rawUrl: `https://www.${id}.example/`,
        userId: null,
        requesterEmail: null,
        source: 'web',
        userAgent: 'ua',
        status: 'new',
        createdAt: new Date(createdAt),
        importedAt: null,
        ...overrides,
    })
}

function listRequest(query = '', headers: Record<string, string> = {}) {
    return new NextRequest(
        `http://localhost/api/ingest/site-suggestions${query}`,
        { method: 'GET', headers },
    )
}

function ackRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/ingest/site-suggestions/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

const bearer = { authorization: `Bearer ${INGEST_KEY}` }

beforeEach(() => {
    envMock.INGEST_API_KEY = INGEST_KEY
    table.length = 0
    prismaMock.siteSuggestion.findMany.mockClear()
    prismaMock.siteSuggestion.updateMany.mockClear()
})

describe('GET /api/ingest/site-suggestions — bearer gate (apiKey:ingest)', () => {
    it('no Authorization header → 401, nothing read', async () => {
        seed('a', '2026-09-01T00:00:00.000Z')
        const res = await listGET(listRequest())
        expect(res.status).toBe(401)
        expect(prismaMock.siteSuggestion.findMany).not.toHaveBeenCalled()
    })

    it('wrong bearer → 401', async () => {
        const res = await listGET(
            listRequest('', { authorization: 'Bearer nope' }),
        )
        expect(res.status).toBe(401)
    })

    it('INGEST_API_KEY unset → 401 even with a bearer (fail-closed, like ingest/catalog)', async () => {
        envMock.INGEST_API_KEY = undefined
        const res = await listGET(listRequest('', bearer))
        expect(res.status).toBe(401)
    })
})

describe('GET /api/ingest/site-suggestions — the cross-repo contract', () => {
    it('returns the `new` rows oldest-first in EXACTLY the documented wire shape', async () => {
        seed('later', '2026-09-02T00:00:00.000Z', {
            requesterEmail: 'shopper@example.com',
            userId: 'user-1',
        })
        seed('earlier', '2026-09-01T00:00:00.000Z')
        seed('done', '2026-08-01T00:00:00.000Z', { status: 'imported' })

        const res = await listGET(listRequest('', bearer))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            suggestions: [
                {
                    id: 'earlier',
                    domain: 'earlier.example',
                    rawUrl: 'https://www.earlier.example/',
                    requesterEmail: null,
                    source: 'web',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    status: 'new',
                },
                {
                    id: 'later',
                    domain: 'later.example',
                    rawUrl: 'https://www.later.example/',
                    requesterEmail: 'shopper@example.com',
                    source: 'web',
                    createdAt: '2026-09-02T00:00:00.000Z',
                    status: 'new',
                },
            ],
        })
    })

    it('the wire row carries NO user id and NO user agent — the consumer gets contact + domain, never account internals', async () => {
        seed('a', '2026-09-01T00:00:00.000Z', { userId: 'user-1' })
        const res = await listGET(listRequest('', bearer))
        const { suggestions } = (await res.json()) as {
            suggestions: Record<string, unknown>[]
        }
        // Exact key set AND order — the lib builds the wire object literally.
        expect(Object.keys(suggestions[0]!)).toEqual([
            'id',
            'domain',
            'rawUrl',
            'requesterEmail',
            'source',
            'createdAt',
            'status',
        ])
    })

    it('?status=imported reads the acknowledged rows instead', async () => {
        seed('a', '2026-09-01T00:00:00.000Z')
        seed('b', '2026-09-01T00:00:00.000Z', { status: 'imported' })
        const res = await listGET(listRequest('?status=imported', bearer))
        const { suggestions } = (await res.json()) as {
            suggestions: { id: string }[]
        }
        expect(suggestions.map(s => s.id)).toEqual(['b'])
    })

    it('?since=<iso> keeps rows created at or after that instant', async () => {
        seed('old', '2026-09-01T00:00:00.000Z')
        seed('edge', '2026-09-05T00:00:00.000Z')
        seed('fresh', '2026-09-06T00:00:00.000Z')
        const res = await listGET(
            listRequest('?since=2026-09-05T00:00:00.000Z', bearer),
        )
        const { suggestions } = (await res.json()) as {
            suggestions: { id: string }[]
        }
        expect(suggestions.map(s => s.id)).toEqual(['edge', 'fresh'])
    })

    it('?limit caps the page (default 500, max 1000); an unknown status or an oversized limit → 422', async () => {
        for (let i = 0; i < 4; i += 1) {
            seed(`r${i}`, `2026-09-0${i + 1}T00:00:00.000Z`)
        }
        const capped = await listGET(listRequest('?limit=2', bearer))
        const { suggestions } = (await capped.json()) as {
            suggestions: { id: string }[]
        }
        expect(suggestions.map(s => s.id)).toEqual(['r0', 'r1'])

        expect((await listGET(listRequest('?limit=5000', bearer))).status).toBe(
            422,
        )
        expect(
            (await listGET(listRequest('?status=whatever', bearer))).status,
        ).toBe(422)
        expect(
            (await listGET(listRequest('?since=yesterday', bearer))).status,
        ).toBe(422)
    })
})

describe('POST /api/ingest/site-suggestions/ack — new -> imported', () => {
    it('no bearer → 401, nothing flipped', async () => {
        seed('a', '2026-09-01T00:00:00.000Z')
        const res = await ackPOST(ackRequest({ ids: ['a'] }))
        expect(res.status).toBe(401)
        expect(table[0]!.status).toBe('new')
    })

    it('flips ONLY the named `new` rows to imported, stamps importedAt, and reports the count', async () => {
        seed('a', '2026-09-01T00:00:00.000Z')
        seed('b', '2026-09-01T00:00:00.000Z')
        seed('c', '2026-09-01T00:00:00.000Z')
        const res = await ackPOST(ackRequest({ ids: ['a', 'b'] }, bearer))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, acknowledged: 2 })
        expect(table.map(r => [r.id, r.status])).toEqual([
            ['a', 'imported'],
            ['b', 'imported'],
            ['c', 'new'],
        ])
        expect(table[0]!.importedAt).toBeInstanceOf(Date)
        expect(table[2]!.importedAt).toBeNull()
    })

    it('is idempotent: a re-ack (or an already-imported id) flips nothing and counts 0', async () => {
        seed('a', '2026-09-01T00:00:00.000Z', {
            status: 'imported',
            importedAt: new Date('2026-09-02T00:00:00.000Z'),
        })
        const res = await ackPOST(ackRequest({ ids: ['a', 'ghost'] }, bearer))
        expect(await res.json()).toEqual({ ok: true, acknowledged: 0 })
        expect(table[0]!.importedAt).toEqual(
            new Date('2026-09-02T00:00:00.000Z'),
        )
    })

    it('an acknowledged row leaves the `new` list', async () => {
        seed('a', '2026-09-01T00:00:00.000Z')
        await ackPOST(ackRequest({ ids: ['a'] }, bearer))
        const res = await listGET(listRequest('', bearer))
        expect(await res.json()).toEqual({ suggestions: [] })
    })

    it('an empty or missing ids list → 422', async () => {
        expect((await ackPOST(ackRequest({ ids: [] }, bearer))).status).toBe(
            422,
        )
        expect((await ackPOST(ackRequest({}, bearer))).status).toBe(422)
        expect(prismaMock.siteSuggestion.updateMany).not.toHaveBeenCalled()
    })
})
