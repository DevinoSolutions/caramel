import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-pick, learned answer: when it may be given
// (opt-in, switch on, no served config), that it costs no model call and no
// budget, what it looks like on the wire, which outcome event it records, and
// that a lookup failure leaves the pick exactly as it was. The serving rule
// itself runs on real Postgres in tests/integration/coupon-box-learned.itest.ts.

// MOCK (announced): the model call, the budget, the two database reads and
// the outcome capture. Whether each is reached is what these tests measure.
const {
    chatMock,
    admitMock,
    envMock,
    findMock,
    servedMock,
    captureMock,
    sentryMock,
} = vi.hoisted(() => ({
    chatMock: vi.fn(
        async (): Promise<string> =>
            JSON.stringify({
                input: 1,
                button: null,
                toggle: null,
                confidence: 90,
            }),
    ),
    admitMock: vi.fn(async (_client: unknown) => {}),
    envMock: {} as Record<string, unknown>,
    findMock: vi.fn(
        async (
            _domain: string,
        ): Promise<{
            input: string
            apply: string | null
            toggle: string | null
            enterOnly: boolean
        } | null> => null,
    ),
    servedMock: vi.fn(async (_host: string) => false),
    captureMock: vi.fn(
        async (_args: { properties: Record<string, unknown> }) => true,
    ),
    sentryMock: vi.fn(),
}))
vi.mock('@/lib/openrouter', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/openrouter')>()),
    chat: chatMock,
}))
vi.mock('@/lib/couponBoxPickBudget', () => ({
    admitCouponBoxPickModelCall: admitMock,
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/couponBoxLearned', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/couponBoxLearned')>()),
    findServableLearnedBox: findMock,
}))
vi.mock('@/lib/couponsRepo', () => ({ hasServedStoreConfig: servedMock }))
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: sentryMock,
    captureMessage: vi.fn(),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))

import { POST } from '@/app/api/extension/coupon-box-pick/route'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const LEARNED = {
    input: '#promo',
    apply: 'button.apply',
    toggle: null,
    enterOnly: false,
}

function pick(acceptsLearned?: unknown) {
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-pick', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: EXT_ORIGIN,
                'cf-connecting-ip': '203.0.113.5',
            },
            body: JSON.stringify({
                // Fresh per call: never an answer-cache hit.
                domain: `shop-${randomUUID().slice(0, 8)}.example`,
                outline: '- [1] textbox "Promo code"',
                ...(acceptsLearned === undefined ? {} : { acceptsLearned }),
            }),
        }),
    )
}

const lastOutcome = () =>
    captureMock.mock.calls[captureMock.mock.calls.length - 1]?.[0].properties
        .outcome as string

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    envMock.COUPON_BOX_LEARNED_SALT = 'unit-salt-unit-salt-unit-salt-unit-salt'
    chatMock.mockClear()
    admitMock.mockClear()
    findMock.mockReset()
    findMock.mockImplementation(async () => LEARNED)
    servedMock.mockReset()
    servedMock.mockImplementation(async () => false)
    captureMock.mockClear()
    sentryMock.mockClear()
})

describe('coupon-box pick: learned answer', () => {
    it('answers from the learned table: selector-bearing shape, no model call, no budget, outcome "learned"', async () => {
        const res = await pick(true)

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: LEARNED,
        })
        expect(chatMock).not.toHaveBeenCalled()
        expect(admitMock).not.toHaveBeenCalled()
        expect(lastOutcome()).toBe('learned')
    })

    it('an old build (no acceptsLearned, or anything but true) never gets one and never touches the table', async () => {
        for (const flag of [undefined, false]) {
            const body = await (await pick(flag)).json()
            expect(body.source).toBeUndefined()
            expect(body.input).toBe(1)
        }
        expect(findMock).not.toHaveBeenCalled()
        expect(servedMock).not.toHaveBeenCalled()
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('served-config domain: never a learned answer, the table is not even read', async () => {
        servedMock.mockImplementation(async () => true)
        const body = await (await pick(true)).json()
        expect(body.source).toBeUndefined()
        expect(findMock).not.toHaveBeenCalled()
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('no salt (learned off): the pick runs as before', async () => {
        envMock.COUPON_BOX_LEARNED_SALT = undefined
        const body = await (await pick(true)).json()
        expect(body.source).toBeUndefined()
        expect(servedMock).not.toHaveBeenCalled()
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('pick switched off: no_pick disabled, learned or not', async () => {
        envMock.COUPON_BOX_LLM_ENABLED = false
        expect(await (await pick(true)).json()).toEqual({
            outcome: 'no_pick',
            reason: 'disabled',
        })
        expect(findMock).not.toHaveBeenCalled()
    })

    it('nothing servable: falls through to the model as before', async () => {
        findMock.mockImplementation(async () => null)
        const body = await (await pick(true)).json()
        expect(body).toMatchObject({ outcome: 'box', input: 1 })
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('a lookup error is reported and the pick carries on to the model', async () => {
        findMock.mockImplementation(async () => {
            throw new Error('db down')
        })
        const res = await pick(true)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ outcome: 'box', input: 1 })
        expect(sentryMock).toHaveBeenCalledTimes(1)
        expect(chatMock).toHaveBeenCalledTimes(1)
    })
})
