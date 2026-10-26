import { POST as dataDelete } from '@/app/api/account/data/delete/route'
import { POST as accountDelete } from '@/app/api/account/delete/route'
import { GET as extensionMe } from '@/app/api/extension/me/route'
import { DELETE as sessionRevoke } from '@/app/api/extension/session/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The native iOS app (apps/caramel-apple) calls the API with an
// `Authorization: Bearer <session token>` and NO Origin header: URLSession
// sends none, and these routes are gated on the Origin only when one is
// present (rateLimit.ts isOriginAllowed lets a missing Origin through; that is
// also how the extension's host_permissions fetches pass).
//
// That permissiveness is load-bearing for the app, so it is pinned here: if a
// later hardening switches an account/* or extension/me route to a strict
// extension-origin check (`origin: 'extension'`, which refuses a missing
// Origin) the app would break silently on a device. The negative control proves
// the gate itself is live: a foreign Origin on the same request is a 403, so
// the passes below are not "no gate at all".
//
// Doubles: prisma, the better-auth session lookup (it resolves a session only
// for the app's bearer, mirroring the bearer plugin), the rate limit.
const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        $transaction: vi.fn(async () => [
            { count: 0 },
            { count: 0 },
            { count: 0 },
            { count: 0 },
        ]),
        user: {
            findUnique: vi.fn(async () => ({ savingsSyncEnabled: true })),
            deleteMany: vi.fn(() => ({ op: 'user' })),
        },
        account: { findMany: vi.fn(async () => []) },
        verification: { deleteMany: vi.fn(() => ({ op: 'verification' })) },
        savingsEvent: { deleteMany: vi.fn() },
        favoriteStore: { deleteMany: vi.fn() },
        couponReport: { deleteMany: vi.fn() },
        siteSuggestion: { updateMany: vi.fn() },
        session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    },
}))
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const APP_BEARER = 'Bearer app-session-token'
vi.mock('@/lib/auth/auth', () => ({
    auth: {
        api: {
            getSession: vi.fn(async ({ headers }: { headers: Headers }) =>
                headers.get('authorization') === APP_BEARER
                    ? {
                          user: {
                              id: 'app-user',
                              email: 'app@example.com',
                              username: 'app-user',
                              name: null,
                              image: null,
                          },
                      }
                    : null,
            ),
        },
        // account/delete expires the session cookies by better-auth's names.
        options: {},
    },
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const BASE = 'https://grabcaramel.test'
const json = { 'content-type': 'application/json' }

const calls: Array<{
    name: string
    gated: boolean
    call: (headers: Record<string, string>) => Promise<Response>
}> = [
    {
        name: 'GET /api/extension/me',
        // extension/me declares no origin gate (CORS only): it answers a
        // foreign Origin too, so it has no negative control.
        gated: false,
        call: headers =>
            extensionMe(
                new NextRequest(`${BASE}/api/extension/me`, { headers }),
            ),
    },
    {
        name: 'POST /api/account/delete',
        gated: true,
        call: headers =>
            accountDelete(
                new NextRequest(`${BASE}/api/account/delete`, {
                    method: 'POST',
                    headers: { ...json, ...headers },
                    body: JSON.stringify({ confirm: 'DELETE' }),
                }),
            ),
    },
    {
        name: 'POST /api/account/data/delete',
        gated: true,
        call: headers =>
            dataDelete(
                new NextRequest(`${BASE}/api/account/data/delete`, {
                    method: 'POST',
                    headers: { ...json, ...headers },
                    body: JSON.stringify({ confirm: 'DELETE' }),
                }),
            ),
    },
    {
        name: 'DELETE /api/extension/session (sign-out revoke)',
        // Possession-gated, any Origin by design (see the route).
        gated: false,
        call: headers =>
            sessionRevoke(
                new NextRequest(`${BASE}/api/extension/session`, {
                    method: 'DELETE',
                    headers,
                }),
            ),
    },
]

beforeEach(() => vi.clearAllMocks())

describe('the native app calls with a bearer and no Origin', () => {
    it.each(calls)('$name accepts it', async ({ call }) => {
        const res = await call({ authorization: APP_BEARER })
        expect(res.status).toBe(200)
    })

    it.each(calls.filter(c => c.gated))(
        '$name refuses a foreign Origin (the gate is live)',
        async ({ call }) => {
            const res = await call({
                authorization: APP_BEARER,
                origin: 'https://evil.example.com',
            })
            expect(res.status).toBe(403)
        },
    )
})
