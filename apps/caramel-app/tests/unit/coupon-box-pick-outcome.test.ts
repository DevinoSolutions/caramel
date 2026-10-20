import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-request outcome event of POST /api/extension/coupon-box-pick
// (src/lib/analytics/couponBoxPickOutcome.ts): every exit of the handler emits
// EXACTLY ONE `coupon_box_pick_outcome`, with the right outcome, latency and
// store, and no PII. Mocked like coupons-submit-route.test.ts: the PostHog
// capture is replaced and after() runs its task inline. The pick's own
// behaviour (cache, index validation, budget) is pinned in
// coupon-box-pick.test.ts; here only what the event says about it.

interface CapturedEvent {
    event: string
    distinctId: string
    properties?: Record<string, unknown>
}

// MOCK (announced): `chat` is the paid model call; `pickMock` passes through to
// the real pickCouponBox and exists only so some tests can make it throw.
const { chatMock, envMock, captureMock, pickMock, checkRateLimitMock } =
    vi.hoisted(() => ({
        chatMock: vi.fn(async (): Promise<string> => '{}'),
        envMock: {} as Record<string, unknown>,
        captureMock: vi.fn(async (_args: CapturedEvent) => true),
        pickMock: vi.fn(),
        checkRateLimitMock: vi.fn(async () => null as unknown),
    }))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}))
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))
// The generic per-IP limiter is switched off, as in coupon-box-pick.test.ts;
// the 'withRoute refuses first' test turns it on for one request.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))
// MOCK (announced): the learned table's two reads (the serving rule runs on
// real Postgres in tests/integration/coupon-box-learned.itest.ts). Only the
// `learned` case below makes a box servable.
const { findLearnedMock } = vi.hoisted(() => ({
    findLearnedMock: vi.fn(async (_domain: string): Promise<unknown> => null),
}))
vi.mock('@/lib/couponBoxLearned', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/couponBoxLearned')>()),
    findServableLearnedBox: findLearnedMock,
}))
vi.mock('@/lib/couponsRepo', () => ({
    hasServedStoreConfig: vi.fn(async () => false),
}))
vi.mock('@/lib/couponBoxPick', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/couponBoxPick')>()
    pickMock.mockImplementation(actual.pickCouponBox)
    return { ...actual, pickCouponBox: pickMock }
})

import { POST } from '@/app/api/extension/coupon-box-pick/route'
import {
    COUPON_BOX_PICK_OUTCOME_EVENT,
    COUPON_BOX_PICK_OUTCOMES,
    type CouponBoxPickOutcome,
} from '@/lib/analytics/couponBoxPickOutcome'
import { MAX_OUTLINE_BYTES } from '@/lib/couponBoxPick'
import {
    COUPON_BOX_PICK_BUDGET,
    resetCouponBoxPickBudgetForTests,
} from '@/lib/couponBoxPickBudget'
import { ModelCallBudgetExceededError } from '@/lib/modelCallBudget'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OUTLINE = [
    '- main:',
    '  - form:',
    '    - [7] textbox "Promo code"',
    '    - [8] button "Apply"',
].join('\n')
const MODEL = 'test/box-model'
const answer = (a: object) => JSON.stringify({ confidence: 90, why: 'x', ...a })
const freshDomain = () => `shop-${randomUUID().slice(0, 8)}.example`

function post(
    body: unknown,
    {
        origin = EXT_ORIGIN,
        ip = '203.0.113.5',
    }: { origin?: string | null; ip?: string } = {},
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
    }
    if (origin) headers.origin = origin
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-pick', {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    )
}

/** The single event the last request emitted. Fails unless there was exactly one. */
function onlyEvent(): CapturedEvent {
    expect(captureMock).toHaveBeenCalledTimes(1)
    const event = captureMock.mock.calls[0]![0]
    expect(event.event).toBe(COUPON_BOX_PICK_OUTCOME_EVENT)
    return event
}

// Every outcome in COUPON_BOX_PICK_OUTCOMES is produced by one case below; the
// last test fails if a name is added to the list without a case.
const seen = new Set<CouponBoxPickOutcome>()
function expectOutcome(outcome: CouponBoxPickOutcome) {
    const event = onlyEvent()
    expect(event.properties?.outcome).toBe(outcome)
    seen.add(outcome)
    return event.properties ?? {}
}

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = MODEL
    chatMock.mockReset()
    chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
    captureMock.mockReset()
    captureMock.mockImplementation(async () => true)
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
    pickMock.mockClear()
    resetCouponBoxPickBudgetForTests()
})

describe('coupon_box_pick_outcome: one event per handler exit', () => {
    it('box: cached false, store, model, latency and model_ms', async () => {
        chatMock.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 30))
            return answer({ input: 7, button: 8 })
        })
        const domain = freshDomain()
        const res = await post({ domain, outline: OUTLINE })
        expect(res.status).toBe(200)
        const props = expectOutcome('box')
        expect(props).toMatchObject({
            cached: false,
            store: domain,
            model: MODEL,
            $process_person_profile: false,
        })
        expect(captureMock.mock.calls[0]![0].distinctId).toBe(
            'server:coupon-box-pick',
        )
        expect(props.model_ms).toBeGreaterThanOrEqual(25)
        expect(props.latency_ms).toBeGreaterThanOrEqual(
            props.model_ms as number,
        )
    })

    it('a cache hit is a box with cached true and no model_ms', async () => {
        const domain = freshDomain()
        await post({ domain, outline: OUTLINE })
        captureMock.mockClear()
        await post({ domain, outline: OUTLINE })
        const props = expectOutcome('box')
        expect(props).toMatchObject({ cached: true, store: domain })
        expect(props).not.toHaveProperty('model_ms')
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('no_box', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: null, toggle: null }),
        )
        await post({ domain: freshDomain(), outline: OUTLINE })
        expectOutcome('no_box')
    })

    it('no_pick:disabled: flag off, with no store (the body is never read)', async () => {
        envMock.COUPON_BOX_LLM_ENABLED = false
        await post({ domain: freshDomain(), outline: OUTLINE })
        const props = expectOutcome('no_pick:disabled')
        expect(props).not.toHaveProperty('store')
        expect(props).not.toHaveProperty('cached')
        expect(props).not.toHaveProperty('model_ms')
        expect(props.latency_ms).toEqual(expect.any(Number))
    })

    it('no_pick:disabled: flag on but no model configured, so no model property either', async () => {
        envMock.COUPON_BOX_PICK_MODEL = undefined
        await post({ domain: freshDomain(), outline: OUTLINE })
        const props = expectOutcome('no_pick:disabled')
        expect(props).not.toHaveProperty('model')
    })

    it('no_pick:model_error carries model_ms (the call was made)', async () => {
        chatMock.mockRejectedValue(new Error('upstream 502'))
        await post({ domain: freshDomain(), outline: OUTLINE })
        const props = expectOutcome('no_pick:model_error')
        expect(props).toMatchObject({ cached: false })
        expect(props.model_ms).toEqual(expect.any(Number))
    })

    it('no_pick:refused_button carries model_ms, and the answer is cached', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 7, button: 9, toggle: null }),
        )
        const domain = freshDomain()
        const outline = `${OUTLINE}
    - [9] button "Checkout"`
        await post({ domain, outline })
        const props = expectOutcome('no_pick:refused_button')
        expect(props).toMatchObject({ cached: false })
        expect(props.model_ms).toEqual(expect.any(Number))
        captureMock.mockClear()
        await post({ domain, outline })
        expect(onlyEvent().properties).toMatchObject({
            outcome: 'no_pick:refused_button',
            cached: true,
        })
    })

    it('no_pick:unparsable', async () => {
        chatMock.mockImplementation(async () => 'sorry, no idea')
        await post({ domain: freshDomain(), outline: OUTLINE })
        const props = expectOutcome('no_pick:unparsable')
        expect(props.model_ms).toEqual(expect.any(Number))
    })

    it('budget_exceeded:client: no model_ms (the model was never called)', async () => {
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.perClient; i++) {
            await post(
                { domain: freshDomain(), outline: OUTLINE },
                { ip: '198.51.100.20' },
            )
        }
        captureMock.mockClear()
        const res = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { ip: '198.51.100.20' },
        )
        expect(res.status).toBe(429)
        const props = expectOutcome('budget_exceeded:client')
        expect(props).toMatchObject({ cached: false })
        expect(props).not.toHaveProperty('model_ms')
    })

    it('budget_exceeded:global', async () => {
        // 20 per client: spread the global budget over distinct clients.
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.global; i++) {
            await post(
                { domain: freshDomain(), outline: OUTLINE },
                { ip: `10.1.${Math.floor(i / 20)}.${(i % 20) + 1}` },
            )
        }
        captureMock.mockClear()
        const res = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { ip: '10.9.9.9' },
        )
        expect(res.status).toBe(429)
        expectOutcome('budget_exceeded:global')
    }, 60_000)

    it('budget_exceeded:daily (the real daily trip is pinned in coupon-box-pick-daily-cap.test.ts)', async () => {
        pickMock.mockRejectedValueOnce(
            new ModelCallBudgetExceededError('coupon-box-pick', 'daily', 600),
        )
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(429)
        expectOutcome('budget_exceeded:daily')
    })

    it('too_large: Content-Length over the body cap, before the body is parsed (no store)', async () => {
        const res = await post({
            domain: freshDomain(),
            outline: 'x'.repeat(60 * 1024),
        })
        expect(res.status).toBe(413)
        expect(expectOutcome('too_large')).not.toHaveProperty('store')
    })

    it('too_large: a chunked body with no Content-Length is read only up to the cap', async () => {
        // 1 MiB offered in 1 KiB chunks, pulled only as the route reads.
        let pulled = 0
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1
                if (pulled > 1024) controller.close()
                else controller.enqueue(new Uint8Array(1024).fill(0x20))
            },
        })
        const req = new NextRequest(
            'http://localhost/api/extension/coupon-box-pick',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: EXT_ORIGIN,
                    'cf-connecting-ip': '203.0.113.9',
                },
                body,
                duplex: 'half',
            } as ConstructorParameters<typeof NextRequest>[1],
        )
        const res = await POST(req)
        expect(res.status).toBe(413)
        expectOutcome('too_large')
        // The 46 KiB cap is passed on the 47th chunk; a few more may be
        // buffered ahead, never the whole body.
        expect(pulled).toBeLessThan(70)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('too_large: an outline over the outline cap carries the (valid) store', async () => {
        // Plain text, so JSON escaping does not push the whole body over the
        // (larger) body cap first.
        const outline = 'a'.repeat(MAX_OUTLINE_BYTES + 1)
        expect(Buffer.byteLength(outline)).toBeGreaterThan(MAX_OUTLINE_BYTES)
        const domain = freshDomain()
        const res = await post({ domain, outline })
        expect(res.status).toBe(413)
        expect(expectOutcome('too_large')).toMatchObject({ store: domain })
    })

    it('invalid: not JSON, and a body that fails the schema (no store)', async () => {
        expect((await post('not json')).status).toBe(400)
        expectOutcome('invalid')
        captureMock.mockClear()
        expect((await post({ domain: 'x', outline: OUTLINE })).status).toBe(400)
        expect(expectOutcome('invalid')).not.toHaveProperty('store')
    })

    it('server_error: an unexpected failure inside the pick', async () => {
        pickMock.mockRejectedValueOnce(new Error('boom'))
        const domain = freshDomain()
        const res = await post({ domain, outline: OUTLINE })
        expect(res.status).toBe(500)
        expect(expectOutcome('server_error')).toMatchObject({ store: domain })
    })

    it('server_error: reading the body itself fails (rethrown to withRoute)', async () => {
        const body = new ReadableStream({
            pull(controller) {
                controller.error(new Error('connection reset'))
            },
        })
        const req = new NextRequest(
            'http://localhost/api/extension/coupon-box-pick',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: EXT_ORIGIN,
                    'cf-connecting-ip': '203.0.113.9',
                },
                body,
                duplex: 'half',
            } as ConstructorParameters<typeof NextRequest>[1],
        )
        const res = await POST(req)
        expect(res.status).toBe(500)
        expectOutcome('server_error')
    })

    it('learned: answered from the learned table, no cache, no model', async () => {
        envMock.COUPON_BOX_LEARNED_ENABLED = true
        envMock.COUPON_BOX_LEARNED_SALT = 'x'.repeat(40)
        findLearnedMock.mockResolvedValueOnce({
            input: '#promo',
            apply: null,
            toggle: null,
            enterOnly: true,
        })
        const domain = freshDomain()
        const res = await post({
            domain,
            outline: OUTLINE,
            acceptsLearned: true,
        })
        expect(await res.json()).toMatchObject({ source: 'learned' })
        const props = expectOutcome('learned')
        expect(props.store).toBe(domain)
        expect(props.cached).toBeUndefined()
        expect(props.model_ms).toBeUndefined()
        expect(chatMock).not.toHaveBeenCalled()
        envMock.COUPON_BOX_LEARNED_ENABLED = false
        envMock.COUPON_BOX_LEARNED_SALT = undefined
    })

    it('covers every name in COUPON_BOX_PICK_OUTCOMES', () => {
        expect(Array.from(seen).sort()).toEqual(
            [...COUPON_BOX_PICK_OUTCOMES].sort(),
        )
    })
})

describe('coupon_box_pick_outcome: what is NOT recorded', () => {
    it('a request withRoute refuses first (no extension Origin, or rate limited) emits nothing', async () => {
        const res = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { origin: null },
        )
        expect(res.status).toBe(403)
        checkRateLimitMock.mockResolvedValueOnce(
            new Response('slow down', { status: 429 }),
        )
        const limited = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(limited.status).toBe(429)
        expect(captureMock).not.toHaveBeenCalled()
    })
})

describe('coupon_box_pick_outcome: no PII, never breaks the response', () => {
    it('carries no IP, user agent or outline text', async () => {
        await post(
            { domain: freshDomain(), outline: OUTLINE },
            { ip: '203.0.113.77' },
        )
        const serialized = JSON.stringify(onlyEvent())
        expect(serialized).not.toContain('203.0.113.77')
        expect(serialized).not.toContain('Promo code')
        expect(serialized).not.toContain('user-agent')
    })

    it('a PostHog failure never changes the response', async () => {
        captureMock.mockRejectedValueOnce(new Error('posthog down'))
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ outcome: 'box' })
    })
})
