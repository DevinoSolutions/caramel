import { DELETE, PUT } from '@/app/api/account/favorites/[store]/route'
import { GET } from '@/app/api/account/favorites/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Favorites-route unit pins — "the stores you follow". Same shape as
// coupons-report.test.ts: mock the app Postgres (@/lib/prisma), keep
// isOriginAllowed real, drive the exported handlers with constructed
// NextRequests.
//
// What these pin, and why each one is here rather than assumed:
//   - the SESSION GATE actually gates (an anonymous caller must never reach the
//     DB — a favorites row is per-person state);
//   - both writes are IDEMPOTENT, in both directions, because two surfaces fire
//     the same toggle and the web star removes optimistically with an undo;
//   - the store key is NORMALIZED at the boundary, so `www.NIKE.com`, a bare
//     hostname and a full URL all key ONE row that joins against the catalog;
//   - garbage that names no store is refused 422 and never reaches Prisma.
const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        favoriteStore: {
            findMany: vi.fn(
                async (_args: unknown) =>
                    [] as { storeName: string; createdAt: Date }[],
            ),
            upsert: vi.fn(async (_args: unknown) => ({})),
            deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
        },
    },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

// Only the rate-limit round-trip is stubbed; isOriginAllowed stays real so a
// no-Origin request passes exactly like the extension's host_permissions fetch.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

const USER_ID = 'user_abc123'

function signedIn(): void {
    getSessionMock.mockResolvedValue({ user: { id: USER_ID } })
}
function signedOut(): void {
    getSessionMock.mockResolvedValue(null)
}

function listRequest(): NextRequest {
    return new NextRequest('http://localhost/api/account/favorites', {
        method: 'GET',
    })
}

function storeRequest(rawStore: string, method: 'PUT' | 'DELETE'): NextRequest {
    return new NextRequest(
        `http://localhost/api/account/favorites/${encodeURIComponent(rawStore)}`,
        { method },
    )
}

beforeEach(() => {
    prismaMock.favoriteStore.findMany.mockClear()
    prismaMock.favoriteStore.findMany.mockResolvedValue([])
    prismaMock.favoriteStore.upsert.mockClear()
    prismaMock.favoriteStore.deleteMany.mockClear()
    getSessionMock.mockReset()
})

describe('favorites routes — the session gate is a real gate', () => {
    it('GET /api/account/favorites 401s an anonymous caller and never queries', async () => {
        signedOut()
        const res = await GET(listRequest())

        expect(res.status).toBe(401)
        expect(prismaMock.favoriteStore.findMany).not.toHaveBeenCalled()
    })

    it('PUT 401s an anonymous caller and writes nothing', async () => {
        signedOut()
        const res = await PUT(storeRequest('nike.com', 'PUT'))

        expect(res.status).toBe(401)
        expect(prismaMock.favoriteStore.upsert).not.toHaveBeenCalled()
    })

    it('DELETE 401s an anonymous caller and deletes nothing', async () => {
        signedOut()
        const res = await DELETE(storeRequest('nike.com', 'DELETE'))

        expect(res.status).toBe(401)
        expect(prismaMock.favoriteStore.deleteMany).not.toHaveBeenCalled()
    })
})

describe('GET /api/account/favorites — the list', () => {
    it('serves only the session user’s rows, newest first, as {store, createdAt}', async () => {
        signedIn()
        prismaMock.favoriteStore.findMany.mockResolvedValue([
            {
                storeName: 'nike.com',
                createdAt: new Date('2026-08-09T10:00:00Z'),
            },
            {
                storeName: 'ebay.com',
                createdAt: new Date('2026-08-01T10:00:00Z'),
            },
        ])

        const res = await GET(listRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            favorites: [
                { store: 'nike.com', createdAt: '2026-08-09T10:00:00.000Z' },
                { store: 'ebay.com', createdAt: '2026-08-01T10:00:00.000Z' },
            ],
        })
        const args = prismaMock.favoriteStore.findMany.mock.calls[0]![0] as {
            where: { userId: string }
            orderBy: { createdAt: string }
        }
        expect(args.where).toEqual({ userId: USER_ID })
        expect(args.orderBy).toEqual({ createdAt: 'desc' })
    })

    it('a user with no favorites gets an empty list, not an error', async () => {
        signedIn()
        const res = await GET(listRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ favorites: [] })
    })
})

describe('PUT /api/account/favorites/:store — idempotent follow', () => {
    it('follows the store and echoes the normalized key', async () => {
        signedIn()
        const res = await PUT(storeRequest('nike.com', 'PUT'))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            store: 'nike.com',
            favorited: true,
        })
        const args = prismaMock.favoriteStore.upsert.mock.calls[0]![0] as {
            where: { userId_storeName: { userId: string; storeName: string } }
            create: { userId: string; storeName: string }
            update: Record<string, unknown>
        }
        expect(args.where.userId_storeName).toEqual({
            userId: USER_ID,
            storeName: 'nike.com',
        })
        expect(args.create).toEqual({ userId: USER_ID, storeName: 'nike.com' })
    })

    it('following an already-followed store is a 200, not a conflict', async () => {
        signedIn()
        const first = await PUT(storeRequest('nike.com', 'PUT'))
        const second = await PUT(storeRequest('nike.com', 'PUT'))

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(await second.json()).toMatchObject({ favorited: true })
        expect(prismaMock.favoriteStore.upsert).toHaveBeenCalledTimes(2)
    })

    it('the upsert’s update clause is EMPTY — re-following never resets createdAt or notifyOnNew', async () => {
        // Re-starring must not reorder the account page's list, and this PR
        // writes no email opt-in anywhere: notify_on_new stays at its default.
        signedIn()
        await PUT(storeRequest('nike.com', 'PUT'))

        const args = prismaMock.favoriteStore.upsert.mock.calls[0]![0] as {
            create: Record<string, unknown>
            update: Record<string, unknown>
        }
        expect(args.update).toEqual({})
        expect(args.create).not.toHaveProperty('notifyOnNew')
        expect(args.create).not.toHaveProperty('createdAt')
    })
})

describe('DELETE /api/account/favorites/:store — idempotent unfollow', () => {
    it('unfollows the store and echoes the normalized key', async () => {
        signedIn()
        const res = await DELETE(storeRequest('nike.com', 'DELETE'))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            store: 'nike.com',
            favorited: false,
        })
        expect(prismaMock.favoriteStore.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER_ID, storeName: 'nike.com' },
        })
    })

    it('unfollowing something not followed is a 200, never a 404', async () => {
        // deleteMany, not delete: `delete` on a missing composite key throws
        // P2025, which would turn a stale popup or a double-tap into a 500.
        signedIn()
        prismaMock.favoriteStore.deleteMany.mockResolvedValue({ count: 0 })

        const first = await DELETE(storeRequest('nike.com', 'DELETE'))
        const second = await DELETE(storeRequest('nike.com', 'DELETE'))

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(await second.json()).toMatchObject({ favorited: false })
    })
})

describe('store-key vocabulary — one row per real store', () => {
    // Every one of these is a different way a caller can name the SAME store:
    // the popup sends the tab hostname, the web page sends the canonical base
    // domain, and a hand-typed URL carries a scheme and a path.
    const sameStore: [string, string][] = [
        ['nike.com', 'nike.com'],
        ['www.nike.com', 'nike.com'],
        ['WWW.NIKE.COM', 'nike.com'],
        ['shop.nike.com', 'nike.com'],
        ['https://www.nike.com/cart?x=1', 'nike.com'],
    ]

    it.each(sameStore)('PUT %s writes store_name %s', async (raw, expected) => {
        signedIn()
        const res = await PUT(storeRequest(raw, 'PUT'))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ store: expected })
        const args = prismaMock.favoriteStore.upsert.mock.calls[0]![0] as {
            create: { storeName: string }
        }
        expect(args.create.storeName).toBe(expected)
    })

    it('a multi-label public suffix keeps its registrable label (mymemory.co.uk, not co.uk)', async () => {
        // The bug storeDomain.ts exists to prevent: "last two labels" collapsed
        // this to the SUFFIX, which matched every UK store in the catalogue.
        signedIn()
        await PUT(storeRequest('www.mymemory.co.uk', 'PUT'))

        const args = prismaMock.favoriteStore.upsert.mock.calls[0]![0] as {
            create: { storeName: string }
        }
        expect(args.create.storeName).toBe('mymemory.co.uk')
    })
})

describe('validation — input that names no store is refused, not stored', () => {
    const garbage = [
        'co.uk', // a bare public suffix is not a store
        'com',
        'localhost',
        'not a domain',
        '../../etc/passwd',
        "nike.com'; DROP TABLE favorite_stores;--",
        '%%%',
    ]

    it.each(garbage)('PUT %j → 422 and writes nothing', async raw => {
        signedIn()
        const res = await PUT(storeRequest(raw, 'PUT'))

        expect(res.status).toBe(422)
        expect(await res.json()).toEqual({ error: 'Invalid store' })
        expect(prismaMock.favoriteStore.upsert).not.toHaveBeenCalled()
    })

    it.each(garbage)('DELETE %j → 422 and deletes nothing', async raw => {
        signedIn()
        const res = await DELETE(storeRequest(raw, 'DELETE'))

        expect(res.status).toBe(422)
        expect(prismaMock.favoriteStore.deleteMany).not.toHaveBeenCalled()
    })

    it('a malformed percent-escape is a 422, not a 500', async () => {
        // decodeURIComponent throws on '%zz'; an unguarded decode would make
        // that an uncaught 500 for what is plainly bad input.
        signedIn()
        const res = await PUT(
            new NextRequest('http://localhost/api/account/favorites/%zz', {
                method: 'PUT',
            }),
        )

        expect(res.status).toBe(422)
        expect(prismaMock.favoriteStore.upsert).not.toHaveBeenCalled()
    })
})
