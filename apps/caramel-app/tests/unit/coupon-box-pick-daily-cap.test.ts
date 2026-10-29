import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-day model-call cap (COUPON_BOX_PICK_DAILY_CAP) on
// /api/extension/coupon-box-pick: the third bucket of its model-call budget.
// The cap is read from env when couponBoxPickBudget.ts loads, so the env mock
// sets it to 3 BEFORE the route is imported; the 0 (kill switch) case loads a
// fresh copy of the modules with the cap at 0.

// MOCK (announced): `chat` is the paid model call — counting its calls IS the
// thing under test (how many times the cap lets us pay).
const { chatMock, envMock, captureMessageMock } = vi.hoisted(() => ({
    chatMock: vi.fn(async (): Promise<string> => '{}'),
    envMock: {} as Record<string, unknown>,
    captureMessageMock: vi.fn(),
}))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, { COUPON_BOX_PICK_DAILY_CAP: 3 })
    return { ...actual, env: envMock }
})
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
}))
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})
// MOCK (announced): the outcome event is pinned in
// coupon-box-pick-outcome.test.ts; after() needs a request scope vitest lacks.
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => true),
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))

import { POST } from '@/app/api/extension/coupon-box-pick/route'
import {
    COUPON_BOX_PICK_BUDGET,
    resetCouponBoxPickBudgetForTests,
} from '@/lib/couponBoxPickBudget'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OUTLINE = [
    '- form:',
    '  - [7] textbox "Promo code"',
    '  - [8] button "Apply"',
].join('\n')
const freshDomain = () => `shop-${randomUUID().slice(0, 8)}.example`

type Post = typeof POST
function postWith(route: Post, domain: string, ip = '203.0.113.5') {
    return route(
        new NextRequest('http://localhost/api/extension/coupon-box-pick', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: EXT_ORIGIN,
                'cf-connecting-ip': ip,
            },
            body: JSON.stringify({ domain, outline: OUTLINE }),
        }),
    )
}
const post = (domain: string, ip?: string) => postWith(POST, domain, ip)

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    chatMock.mockReset()
    chatMock.mockImplementation(async () =>
        JSON.stringify({ input: 7, button: 8, confidence: 90, why: 'x' }),
    )
    captureMessageMock.mockClear()
    resetCouponBoxPickBudgetForTests()
})

describe('COUPON_BOX_PICK_DAILY_CAP on the route', () => {
    it('exposes the configured cap', () => {
        expect(COUPON_BOX_PICK_BUDGET.daily).toBe(3)
    })

    it('allows N uncached model calls, then 429s (scope daily) without calling the model', async () => {
        for (let i = 0; i < 3; i++) {
            expect((await post(freshDomain())).status).toBe(200)
        }
        const refused = await post(freshDomain())
        expect(refused.status).toBe(429)
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(chatMock).toHaveBeenCalledTimes(3)
    })

    it('cache hits are free: repeating one page never spends the cap', async () => {
        const domain = freshDomain()
        for (let i = 0; i < 10; i++) {
            expect((await post(domain)).status).toBe(200)
        }
        expect(chatMock).toHaveBeenCalledTimes(1)
        // The cap still has 2 calls left.
        expect((await post(freshDomain())).status).toBe(200)
        expect((await post(freshDomain())).status).toBe(200)
        expect((await post(freshDomain())).status).toBe(429)
    })

    it('a cached page still answers once the cap is spent', async () => {
        const cachedDomain = freshDomain()
        await post(cachedDomain)
        await post(freshDomain())
        await post(freshDomain())
        expect((await post(freshDomain())).status).toBe(429)
        const hit = await post(cachedDomain)
        expect(hit.status).toBe(200)
        expect(await hit.json()).toMatchObject({ cached: true })
    })

    it('reports to Sentry ONCE per throttle window, however many requests are refused', async () => {
        for (let i = 0; i < 3; i++) await post(freshDomain())
        for (let i = 0; i < 5; i++) {
            expect((await post(freshDomain())).status).toBe(429)
        }
        const daily = captureMessageMock.mock.calls.filter(
            ([message]) => typeof message === 'string' && /daily/.test(message),
        )
        expect(daily).toHaveLength(1)
        expect(daily[0]![1]).toMatchObject({
            tags: { route: 'coupon-box-pick', budget: 'daily' },
            extra: { ceiling: 3, windowSeconds: 24 * 60 * 60 },
        })
    })
})

describe('COUPON_BOX_PICK_DAILY_CAP=0 (the soft kill switch)', () => {
    it('refuses the very first uncached model call with 429 and never calls the model', async () => {
        vi.resetModules()
        envMock.COUPON_BOX_PICK_DAILY_CAP = 0
        const { POST: zeroPost } =
            await import('@/app/api/extension/coupon-box-pick/route')
        const { COUPON_BOX_PICK_BUDGET: zeroBudget } =
            await import('@/lib/couponBoxPickBudget')
        expect(zeroBudget.daily).toBe(0)

        const res = await postWith(zeroPost, freshDomain())
        expect(res.status).toBe(429)
        expect(chatMock).not.toHaveBeenCalled()
    })
})
