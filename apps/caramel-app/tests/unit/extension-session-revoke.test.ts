import { DELETE as revokeDELETE } from '@/app/api/extension/session/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Until this route existed, the extension's "Log out" was storage-only: it
// forgot the bearer locally while the Session row lived out its full 7 days,
// so a token captured before logout kept authenticating and nothing in the
// product could kill it. Sessions accumulated with no way to revoke them.
//
// The security shape here is deliberate and worth pinning, because the
// obvious implementations are both wrong:
//   * `auth: 'session'` would ALSO accept a website cookie, letting a
//     cookie-authenticated caller revoke an arbitrary token it never held.
//   * a 404 for an unknown token would let an unauthenticated caller probe
//     whether a guessed token exists, and would make logout fail for someone
//     whose session had already expired.
// So: authorization is possession, the delete is keyed by the exact presented
// token, and the result is idempotent.
const { deleteManyMock } = vi.hoisted(() => ({
    deleteManyMock: vi.fn(async (_args: { where: { token: string } }) => ({
        count: 1,
    })),
}))
vi.mock('@/lib/prisma', () => ({
    default: { session: { deleteMany: deleteManyMock } },
}))
vi.mock('@/lib/env', () => ({ env: {} }))
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://localhost:58000' }))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const ROUTE = 'https://localhost:58000/api/extension/session'

const del = (headers: Record<string, string> = {}) =>
    revokeDELETE(new NextRequest(ROUTE, { method: 'DELETE', headers }))

beforeEach(() => {
    deleteManyMock.mockClear()
    deleteManyMock.mockResolvedValue({ count: 1 })
})

describe('DELETE /api/extension/session — revoking an extension session', () => {
    it('deletes the session row for the exact token presented', async () => {
        const res = await del({ authorization: 'Bearer the-live-token' })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ revoked: true })
        // Keyed by the presented token: a caller can only ever revoke the
        // session it already holds, which is less power than it had before.
        expect(deleteManyMock).toHaveBeenCalledWith({
            where: { token: 'the-live-token' },
        })
    })

    it('is idempotent — an already-revoked token still succeeds', async () => {
        deleteManyMock.mockResolvedValue({ count: 0 })

        const res = await del({ authorization: 'Bearer already-gone' })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ revoked: false })
    })

    it('401s when no bearer token is presented, and touches nothing', async () => {
        const res = await del()

        expect(res.status).toBe(401)
        expect(deleteManyMock).not.toHaveBeenCalled()
    })

    it('401s on a non-bearer Authorization scheme rather than deleting a stray value', async () => {
        // `Basic abc` must never be read as the token `abc`.
        const res = await del({ authorization: 'Basic abc' })

        expect(res.status).toBe(401)
        expect(deleteManyMock).not.toHaveBeenCalled()
    })

    it('never issues an unbounded delete, whatever the header looks like', async () => {
        // The failure that would matter most: a where-clause that misses the
        // token and wipes every session in the table.
        for (const header of [
            'Bearer ',
            'Bearer    ',
            'bearer lowercase-scheme',
        ]) {
            deleteManyMock.mockClear()
            await del({ authorization: header })
            for (const call of deleteManyMock.mock.calls) {
                expect(call[0]?.where?.token).toBeTruthy()
            }
        }
    })
})
