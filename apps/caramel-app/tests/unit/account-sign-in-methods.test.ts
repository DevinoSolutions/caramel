import { GET } from '@/app/api/account/sign-in-methods/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/account/sign-in-methods — the caller's ways in for /profile >
// "Sign-in methods". A password row a take-back cleared is no way in and is
// left out; the password itself never leaves the server. Session-gated.

type Row = { id: string; providerId: string; password: string | null }

const { prismaMock, db } = vi.hoisted(() => {
    const state = { rows: new Map<string, Row[]>() }
    return {
        db: state,
        prismaMock: {
            account: {
                findMany: vi.fn(
                    async (args: { where: { userId: string } }) =>
                        state.rows.get(args.where.userId) ?? [],
                ),
            },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-id' as
            string | undefined,
        FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
        SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(async () => null as unknown),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return {
        ...actual,
        checkRateLimit: vi.fn(async () => null),
    }
})

function getRequest(): NextRequest {
    return new NextRequest('http://localhost/api/account/sign-in-methods', {
        method: 'GET',
    })
}

beforeEach(() => {
    db.rows.clear()
    prismaMock.account.findMany.mockClear()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
})

describe('GET /api/account/sign-in-methods', () => {
    it("lists the caller's ways in by row id and provider, never the password", async () => {
        db.rows.set('user-1', [
            { id: 'acc-pw', providerId: 'credential', password: 'hash' },
            { id: 'acc-google', providerId: 'google', password: null },
        ])
        const res = await GET(getRequest())
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({
            accounts: [
                { id: 'acc-pw', providerId: 'credential' },
                { id: 'acc-google', providerId: 'google' },
            ],
        })
        expect(JSON.stringify(body)).not.toContain('hash')
        expect(prismaMock.account.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'user-1' } }),
        )
    })

    it('leaves out a password row whose password a take-back cleared', async () => {
        db.rows.set('user-1', [
            { id: 'acc-pw', providerId: 'credential', password: null },
            { id: 'acc-apple', providerId: 'apple', password: null },
        ])
        const res = await GET(getRequest())
        expect(await res.json()).toEqual({
            accounts: [{ id: 'acc-apple', providerId: 'apple' }],
        })
    })

    it('refuses a caller with no session', async () => {
        getSessionMock.mockResolvedValue(null)
        const res = await GET(getRequest())
        expect(res.status).toBe(401)
        expect(prismaMock.account.findMany).not.toHaveBeenCalled()
    })
})
