import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security report 2026-10: /api/classify-cart's only gate is
// `origin: 'extension'`, and a forged `Origin: chrome-extension://<anything>`
// from curl reached the paid model on prod (200, `cached:false`). The fix does
// not pretend the origin can be trusted — it caps SPEND (uncached model calls)
// per client and globally (src/lib/classifyCartModelBudget.ts). Every request
// below carries a FORGED extension origin, i.e. exactly the attacker's shape.

// MOCK (announced): `chat` is the paid OpenRouter call — counting its calls IS
// the thing under test (how many times a sender can make us pay).
const { chatMock, captureMessageMock, reportRejectionMock } = vi.hoisted(
    () => ({
        chatMock: vi.fn(async () =>
            JSON.stringify({ primary: 'apparel', confidence: 0.9 }),
        ),
        captureMessageMock: vi.fn(),
        reportRejectionMock: vi.fn(async () => false),
    }),
)
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
}))
// MOCK (announced): abuseSignal's own throttling/PostHog fan-out is pinned in
// abuse-signal.test.ts; here we only assert a per-client trip is handed to it.
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: reportRejectionMock,
}))
// The route's GENERIC per-IP limiter (30/min + burst) is rateLimit.ts's own,
// already pinned elsewhere; it is switched off here so these tests measure the
// model-call budget alone, as an IP-rotating sender would experience it.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { POST as classifyCartPOST } from '@/app/api/classify-cart/route'
import {
    CLASSIFY_MODEL_BUDGET,
    resetClassifyModelBudgetForTests,
} from '@/lib/classifyCartModelBudget'

const FORGED_ORIGIN = 'chrome-extension://forgedforgedforgedforgedforgedfo'

/** A forged-origin request from `ip`. Distinct domain per call = a guaranteed
 * cache miss (the attacker's cheapest way to force a paid call), unless
 * `domain` is pinned. */
function forged(ip: string, domain = `shop-${randomUUID()}.example`) {
    return classifyCartPOST(
        new NextRequest('http://localhost/api/classify-cart', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: FORGED_ORIGIN,
                'cf-connecting-ip': ip,
            },
            body: JSON.stringify({ domain, title: 'Your cart' }),
        }),
    )
}

beforeEach(() => {
    resetClassifyModelBudgetForTests()
    chatMock.mockClear()
    captureMessageMock.mockClear()
    reportRejectionMock.mockClear()
})

describe('classify-cart model-call budget', () => {
    it('one client: allows its budget of paid calls, then 429s without calling the model', async () => {
        for (let i = 0; i < CLASSIFY_MODEL_BUDGET.perClient; i++) {
            expect((await forged('203.0.113.7')).status).toBe(200)
        }
        const refused = await forged('203.0.113.7')
        expect(refused.status).toBe(429)
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(chatMock).toHaveBeenCalledTimes(CLASSIFY_MODEL_BUDGET.perClient)
        expect(reportRejectionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                ip: '203.0.113.7',
                kind: 'classify-model',
            }),
        )
        // …and a different client is unaffected.
        expect((await forged('198.51.100.9')).status).toBe(200)
    })

    it('cache hits are free: repeating one cart never spends budget', async () => {
        for (let i = 0; i < CLASSIFY_MODEL_BUDGET.perClient * 3; i++) {
            expect(
                (await forged('203.0.113.8', 'same-shop.example')).status,
            ).toBe(200)
        }
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('IP rotation: the global ceiling bounds total spend, reported to Sentry ONCE', async () => {
        // Enough distinct "clients" to exhaust the global ceiling without
        // any of them hitting its own per-client bucket.
        const clients = Math.ceil(
            CLASSIFY_MODEL_BUDGET.global / CLASSIFY_MODEL_BUDGET.perClient,
        )
        let ok = 0
        for (let c = 0; c < clients; c++) {
            for (let i = 0; i < CLASSIFY_MODEL_BUDGET.perClient; i++) {
                if ((await forged(`10.0.${c}.1`)).status === 200) ok++
            }
        }
        expect(ok).toBe(CLASSIFY_MODEL_BUDGET.global)

        // Fresh addresses get nothing more once the ceiling is spent.
        for (let i = 0; i < 5; i++) {
            expect((await forged(`192.0.2.${i}`)).status).toBe(429)
        }
        expect(chatMock).toHaveBeenCalledTimes(CLASSIFY_MODEL_BUDGET.global)
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
        expect(captureMessageMock).toHaveBeenCalledWith(
            'classify-cart global model-call budget exhausted',
            expect.objectContaining({ level: 'warning' }),
        )
    })
})
