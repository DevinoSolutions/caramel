import { PATCH } from '@/app/api/account/prompts/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Settings > "Show tips and prompts" — the growth-prompt kill switch. ONE
// authority (the users row), persisted value echoed back, session-gated.

const { prismaMock, db } = vi.hoisted(() => {
    const state = { enabled: new Map<string, boolean>() }
    return {
        db: state,
        prismaMock: {
            user: {
                update: vi.fn(
                    async (args: {
                        where: { id: string }
                        data: { growthPromptsEnabled: boolean }
                    }) => {
                        state.enabled.set(
                            args.where.id,
                            args.data.growthPromptsEnabled,
                        )
                        return {
                            growthPromptsEnabled:
                                args.data.growthPromptsEnabled,
                        }
                    },
                ),
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
    return {
        ...actual,
        checkRateLimit: vi.fn(async () => null),
    }
})

function patchRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/account/prompts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

beforeEach(() => {
    db.enabled.clear()
    prismaMock.user.update.mockClear()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
})

describe('PATCH /api/account/prompts', () => {
    it('turns prompts off and echoes the persisted value', async () => {
        const res = await PATCH(patchRequest({ enabled: false }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ growthPromptsEnabled: false })
        expect(db.enabled.get('user-1')).toBe(false)
    })

    it('turns them back on', async () => {
        await PATCH(patchRequest({ enabled: false }))
        const res = await PATCH(patchRequest({ enabled: true }))
        expect(await res.json()).toEqual({ growthPromptsEnabled: true })
    })

    it('writes only the calling user', async () => {
        await PATCH(patchRequest({ enabled: false }))
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'user-1' } }),
        )
    })

    it('422s a non-boolean rather than coercing it', async () => {
        const res = await PATCH(patchRequest({ enabled: 'no' }))
        expect(res.status).toBe(422)
        expect(prismaMock.user.update).not.toHaveBeenCalled()
    })

    it('requires a session', async () => {
        getSessionMock.mockResolvedValue(null)
        const res = await PATCH(patchRequest({ enabled: false }))
        expect(res.status).toBe(401)
        expect(prismaMock.user.update).not.toHaveBeenCalled()
    })
})
