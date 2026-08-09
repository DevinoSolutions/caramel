import { PATCH } from '@/app/api/account/savings-sync/route'
import { GET as EXTENSION_ME } from '@/app/api/extension/me/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The savings-sync consent flag, and the two routes that make it ONE authority:
// PATCH /api/account/savings-sync writes it, GET /api/extension/me reports it to
// the popup. Both are pinned here together because the bug they exist to prevent
// is a disagreement BETWEEN them.

const { prismaMock, db } = vi.hoisted(() => {
    const state = { savingsSyncEnabled: new Map<string, boolean>() }
    return {
        db: state,
        prismaMock: {
            user: {
                update: vi.fn(
                    async (args: {
                        where: { id: string }
                        data: { savingsSyncEnabled: boolean }
                    }) => {
                        state.savingsSyncEnabled.set(
                            args.where.id,
                            args.data.savingsSyncEnabled,
                        )
                        return {
                            savingsSyncEnabled: args.data.savingsSyncEnabled,
                        }
                    },
                ),
                findUnique: vi.fn(async (args: { where: { id: string } }) => ({
                    savingsSyncEnabled:
                        state.savingsSyncEnabled.get(args.where.id) ?? false,
                })),
            },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-id' as
            | string
            | undefined,
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
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

function patchRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/account/savings-sync', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

function signedIn(id = 'user-1') {
    getSessionMock.mockResolvedValue({
        user: { id, username: 'ada', image: null },
        session: { id: 'sess' },
    })
}

beforeEach(() => {
    db.savingsSyncEnabled.clear()
    prismaMock.user.update.mockClear()
    prismaMock.user.findUnique.mockClear()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
})

describe('PATCH /api/account/savings-sync', () => {
    it('401s a signed-out caller and changes nothing', async () => {
        const res = await PATCH(patchRequest({ enabled: true }))
        expect(res.status).toBe(401)
        expect(prismaMock.user.update).not.toHaveBeenCalled()
    })

    it('turns sync on for the signed-in user', async () => {
        signedIn('user-7')
        const res = await PATCH(patchRequest({ enabled: true }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ savingsSyncEnabled: true })
        expect(db.savingsSyncEnabled.get('user-7')).toBe(true)
    })

    it('turns sync off again — the switch is reversible in one tap', async () => {
        signedIn('user-7')
        await PATCH(patchRequest({ enabled: true }))
        const res = await PATCH(patchRequest({ enabled: false }))

        expect(await res.json()).toEqual({ savingsSyncEnabled: false })
        expect(db.savingsSyncEnabled.get('user-7')).toBe(false)
    })

    it('writes only the caller’s own row', async () => {
        signedIn('user-7')
        await PATCH(patchRequest({ enabled: true, userId: 'someone-else' }))
        expect(prismaMock.user.update.mock.calls[0]![0].where).toEqual({
            id: 'user-7',
        })
    })

    it('422s a non-boolean rather than coercing it', async () => {
        signedIn()
        // 'false' the string is truthy; coercion here would silently opt a
        // shopper IN to uploading their shopping record.
        const res = await PATCH(patchRequest({ enabled: 'false' }))
        expect(res.status).toBe(422)
        expect(prismaMock.user.update).not.toHaveBeenCalled()
    })

    it('422s a missing enabled field', async () => {
        signedIn()
        const res = await PATCH(patchRequest({}))
        expect(res.status).toBe(422)
    })

    it('answers with the PERSISTED value, not the requested one', async () => {
        signedIn('user-7')
        // A store that saved something other than what was asked (a trigger, a
        // partial write) must be visible to the client, not papered over by
        // echoing the request back.
        prismaMock.user.update.mockResolvedValueOnce({
            savingsSyncEnabled: false,
        })
        const res = await PATCH(patchRequest({ enabled: true }))
        expect(await res.json()).toEqual({ savingsSyncEnabled: false })
    })
})

function meRequest(): NextRequest {
    return new NextRequest('http://localhost/api/extension/me', {
        headers: { origin: 'chrome-extension://known-id' },
    })
}

describe('GET /api/extension/me reports the same flag the popup switch renders', () => {
    it('defaults to off for an account that never opted in', async () => {
        signedIn('user-new')
        const res = await EXTENSION_ME(meRequest())
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ savingsSyncEnabled: false })
    })

    it('reports on once the account has opted in', async () => {
        signedIn('user-7')
        await PATCH(patchRequest({ enabled: true }))

        const res = await EXTENSION_ME(meRequest())
        expect(await res.json()).toMatchObject({ savingsSyncEnabled: true })
    })

    it('reads the flag from the users table, never off the session object', async () => {
        // better-auth projects only the fields it knows onto session.user, so a
        // custom column arrives there as undefined — falsy, and therefore
        // indistinguishable from a real "off". A session that CLAIMS the flag
        // must not be believed.
        getSessionMock.mockResolvedValue({
            user: {
                id: 'user-7',
                username: 'ada',
                image: null,
                savingsSyncEnabled: false,
            },
            session: { id: 'sess' },
        })
        db.savingsSyncEnabled.set('user-7', true)

        const res = await EXTENSION_ME(meRequest())
        expect(await res.json()).toMatchObject({ savingsSyncEnabled: true })
        expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1)
    })

    it('still carries the identity fields the popup already depended on', async () => {
        signedIn('user-7')
        const res = await EXTENSION_ME(meRequest())
        expect(await res.json()).toEqual({
            username: 'ada',
            image: null,
            savingsSyncEnabled: false,
        })
    })
})
