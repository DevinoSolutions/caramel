import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-pick + src/lib/couponBoxPick.ts: the feature
// switch, the server-side re-scrub, index validation, the answer cache, the
// model-call budget, and that a model failure is a "no pick", never a 500.

// MOCK (announced): `chat` is the paid model call — whether and how often it
// runs, and what it is sent, is what these tests measure.
const { chatMock, envMock, captureExceptionMock, captureMessageMock } =
    vi.hoisted(() => ({
        chatMock: vi.fn(async (): Promise<string> => '{}'),
        envMock: {} as Record<string, unknown>,
        captureExceptionMock: vi.fn(),
        captureMessageMock: vi.fn(),
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
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
}))
// MOCK (announced): abuseSignal's throttling/PostHog fan-out is pinned in
// abuse-signal.test.ts; here a per-client trip only needs to be harmless.
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))
// MOCK (announced): the outcome event (coupon-box-pick-outcome.test.ts pins
// it) must not leave the process, and after() needs a Next request scope vitest
// does not have, so it runs its task inline.
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => true),
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))
// The route's generic per-IP limiter is rateLimit.ts's own, pinned elsewhere;
// switched off so these tests measure the model-call budget alone.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { OPTIONS, POST } from '@/app/api/extension/coupon-box-pick/route'
import { GET as featuresGET } from '@/app/api/extension/features/route'
import {
    CouponBoxOutlineTooLargeError,
    MAX_OUTLINE_BYTES,
    pickCouponBox,
    scrubOutline,
} from '@/lib/couponBoxPick'
import {
    COUPON_BOX_PICK_BUDGET,
    resetCouponBoxPickBudgetForTests,
} from '@/lib/couponBoxPickBudget'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const OUTLINE = [
    '- main:',
    '  - [3] link "Cart"',
    '  - form:',
    '    - [7] textbox "Promo code"',
    '    - [8] button "Apply"',
    '  - [12] button "Have a promo code?"',
].join('\n')

const answer = (a: object) => JSON.stringify({ confidence: 90, why: 'x', ...a })

/** A fresh domain per call is a guaranteed cache miss. */
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

async function readFeatures() {
    const res = await featuresGET(
        new NextRequest('http://localhost/api/extension/features'),
    )
    return res.json()
}

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    chatMock.mockReset()
    chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
    captureExceptionMock.mockClear()
    captureMessageMock.mockClear()
    resetCouponBoxPickBudgetForTests()
})

describe('feature switch', () => {
    it('flag off: answers no_pick/disabled and never calls the model', async () => {
        envMock.COUPON_BOX_LLM_ENABLED = false
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'disabled',
        })
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('flag on but no model configured: still disabled, no model call', async () => {
        envMock.COUPON_BOX_PICK_MODEL = undefined
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'disabled',
        })
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('features route reports couponBoxLlm with the same condition', async () => {
        expect((await readFeatures()).couponBoxLlm).toBe(true)
        envMock.COUPON_BOX_PICK_MODEL = undefined
        expect((await readFeatures()).couponBoxLlm).toBe(false)
        envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
        envMock.COUPON_BOX_LLM_ENABLED = false
        expect((await readFeatures()).couponBoxLlm).toBe(false)
    })
})

describe('request gates', () => {
    it('refuses a request without an extension Origin (403), no model call', async () => {
        const res = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { origin: null },
        )
        expect(res.status).toBe(403)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('rejects a malformed body with 400', async () => {
        expect((await post('not json')).status).toBe(400)
        expect((await post({ domain: 'x', outline: OUTLINE })).status).toBe(400)
        expect((await post({ domain: freshDomain() })).status).toBe(400)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('rejects an outline over the cap with 413, and the lib refuses it too', async () => {
        const outline = `- [1] textbox "Promo"\n${'- heading "x"\n'.repeat(3500)}`
        expect(Buffer.byteLength(outline)).toBeGreaterThan(MAX_OUTLINE_BYTES)
        expect((await post({ domain: freshDomain(), outline })).status).toBe(
            413,
        )
        await expect(
            pickCouponBox({ domain: freshDomain(), outline }),
        ).rejects.toBeInstanceOf(CouponBoxOutlineTooLargeError)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('answers a preflight with 204', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/coupon-box-pick', {
                method: 'OPTIONS',
            }),
        )
        expect(res.status).toBe(204)
    })
})

describe('the pick', () => {
    it('returns the picked indexes', async () => {
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'box',
            input: 7,
            button: 8,
            toggle: null,
            confidence: 90,
            why: 'x',
            cached: false,
        })
    })

    it('sends the configured model, the outline under a Store line, and the exact-model header', async () => {
        const domain = freshDomain()
        await pickCouponBox({ domain, outline: OUTLINE })
        expect(chatMock).toHaveBeenCalledTimes(1)
        const [messages, opts] = chatMock.mock.calls[0] as unknown as [
            { role: string; content: string }[],
            Record<string, unknown>,
        ]
        expect(messages[0]!.role).toBe('system')
        expect(messages[1]).toEqual({
            role: 'user',
            content: `Store: ${domain}\n\n${OUTLINE}`,
        })
        expect(opts).toMatchObject({
            model: 'test/box-model',
            temperature: 0,
            responseFormat: 'json_object',
            headers: { 'X-ORF-Strict': '1' },
        })
    })

    it('re-scrubs digits and emails before sending, keeping the [n] indexes', async () => {
        const outline = [
            '- [10004] button "Order Summary 12 €"',
            '- [7] textbox "Promo code"',
            '- text "Signed in as jane.doe+x@mail.example.com since 2024"',
        ].join('\n')
        expect(scrubOutline(outline)).toBe(
            [
                '- [10004] button "Order Summary ## €"',
                '- [7] textbox "Promo code"',
                '- text "Signed in as [email] since ####"',
            ].join('\n'),
        )
        await pickCouponBox({ domain: freshDomain(), outline })
        const [messages] = chatMock.mock.calls[0] as unknown as [
            { content: string }[],
        ]
        const sent = messages[1]!.content
        expect(sent).not.toMatch(/jane|2024|12 €/)
        expect(sent).toContain('[10004] button "Order Summary ## €"')
    })

    it('keeps every index across CR, CRLF and Unicode line breaks', () => {
        expect(
            scrubOutline(
                '- [7] textbox "Promo"\r\n- [8] button "Apply"\r- [9] link "Pr omo 5"',
            ),
        ).toBe(
            '- [7] textbox "Promo"\n- [8] button "Apply"\n- [9] link "Pr\nomo #"',
        )
    })

    it('scrubs a number that only looks like an index', () => {
        expect(
            scrubOutline(
                ['- [4155551234] textbox "x"', '- [12] "call 555"'].join('\n'),
            ),
        ).toBe(['- [##########] textbox "x"', '- [##] "call ###"'].join('\n'))
    })

    it('scrubs digits in any script, not only 0-9', () => {
        expect(scrubOutline('- [3] button "to ۰۹۱۲ ٠١٢ ０３１ ①𝟏Ⅷ"')).toBe(
            '- [3] button "to #### ### ### ###"',
        )
    })

    it('drops an index that is not in the outline (a hallucination)', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 99, button: 8, toggle: 12 }),
        )
        const result = await pickCouponBox({
            domain: freshDomain(),
            outline: OUTLINE,
        })
        expect(result).toMatchObject({
            outcome: 'box',
            input: null,
            button: 8,
            toggle: 12,
        })
    })

    it('no input and no toggle is a "no box" answer', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: null, button: null, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toEqual({
            outcome: 'no_box',
            confidence: 90,
            why: 'x',
            cached: false,
        })

        // A hallucinated input with no toggle is "no box" too.
        chatMock.mockImplementation(async () =>
            answer({ input: 404, button: 8, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    // The extension types into the input and CLICKS the button and toggle,
    // so an index of the wrong kind of element, or of a control that leaves
    // the cart or spends money, is refused.
    const GUARDED = [
        '- main:',
        '  - [2] textbox "Promo code"',
        '  - [3] button "Apply"',
        '  - [4] button "Checkout"',
        '  - [5] link "Remove item"',
        '  - [6] button "Place order"',
        '  - [7] button "Sign in"',
        '  - [8] link "Continue shopping"',
        '  - [9] checkbox "Gift wrap"',
        '  - [10] button "Have a promo code?"',
        '  - [11] button "Pay with PayPal"',
    ].join('\n')

    it.each([4, 5, 6, 7, 8, 11])(
        'never returns control [%i] as the apply button',
        async n => {
            chatMock.mockImplementation(async () =>
                answer({ input: 2, button: n, toggle: null }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: GUARDED,
                }),
            ).toMatchObject({ outcome: 'box', input: 2, button: null })
        },
    )

    it.each([4, 5, 6, 7, 11])(
        'never returns control [%i] as the toggle',
        async n => {
            chatMock.mockImplementation(async () =>
                answer({ input: null, button: null, toggle: n }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: GUARDED,
                }),
            ).toMatchObject({ outcome: 'no_box' })
        },
    )

    it('refuses an input that is not a text field', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 9, button: 3, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: GUARDED }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it('keeps a real apply button and a real toggle', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 2, button: 3, toggle: 10 }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: GUARDED }),
        ).toMatchObject({ outcome: 'box', input: 2, button: 3, toggle: 10 })
    })

    it('reads the first JSON object out of a reply with prose around it', async () => {
        chatMock.mockImplementation(
            async () => `Sure: ${answer({ input: 7 })}\nHope that helps {}`,
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toMatchObject({ outcome: 'box', input: 7 })
    })

    // A cosmetic field going wrong never throws away a usable pick: the
    // confidence is clamped, a missing reason is empty, and a malformed index
    // is a non-answer for that field alone.
    it.each([
        [
            'an out-of-range confidence',
            answer({ input: 7, confidence: 150 }),
            { input: 7, confidence: 100 },
        ],
        [
            'a string confidence',
            answer({ input: 7, confidence: '80' }),
            { input: 7, confidence: 80 },
        ],
        [
            'a missing why',
            JSON.stringify({ input: 7, button: 8, confidence: 90 }),
            { input: 7, button: 8, why: '' },
        ],
        [
            'a non-integer button',
            answer({ input: 7, button: 'eight' }),
            { input: 7, button: null },
        ],
    ])(
        'keeps the pick when the reply has %s',
        async (_label, reply, expected) => {
            chatMock.mockImplementation(async () => reply)
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: OUTLINE,
                }),
            ).toMatchObject({ outcome: 'box', ...expected })
        },
    )

    it.each([
        ['non-JSON prose', 'I think the promo box is number seven.'],
        ['a JSON array', '[7, 8]'],
    ])(
        'malformed output (%s) is no_pick/unparsable, logged to Sentry, never cached',
        async (_label, reply) => {
            chatMock.mockImplementation(async () => reply)
            const domain = freshDomain()
            const res = await post({ domain, outline: OUTLINE })
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({
                outcome: 'no_pick',
                reason: 'unparsable',
            })
            expect(captureMessageMock).toHaveBeenCalledWith(
                'coupon-box-pick: unusable model reply',
                expect.objectContaining({ level: 'warning' }),
            )
            // Not cached: the next identical request asks the model again.
            await post({ domain, outline: OUTLINE })
            expect(chatMock).toHaveBeenCalledTimes(2)
        },
    )

    it('a model error is no_pick/model_error (a 200, not a 500), logged to Sentry', async () => {
        chatMock.mockImplementation(async () => {
            throw new Error('upstream 503')
        })
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'model_error',
        })
        expect(captureExceptionMock).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: expect.objectContaining({ surface: 'coupon-box-pick' }),
            }),
        )
    })

    it('a repeated (store, outline) is a cache hit: the model is not called again', async () => {
        const domain = freshDomain()
        const first = await post({ domain, outline: OUTLINE })
        const second = await post({ domain, outline: OUTLINE })
        expect((await first.json()).cached).toBe(false)
        expect(await second.json()).toMatchObject({
            outcome: 'box',
            input: 7,
            cached: true,
        })
        expect(chatMock).toHaveBeenCalledTimes(1)
        // A different store with the same outline is a different answer.
        await post({ domain: freshDomain(), outline: OUTLINE })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })
})

describe('model-call budget', () => {
    it('one client: allows its budget of paid calls, then 429s without calling the model', async () => {
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.perClient; i++) {
            expect(
                (
                    await post(
                        { domain: freshDomain(), outline: OUTLINE },
                        { ip: '198.51.100.20' },
                    )
                ).status,
            ).toBe(200)
        }
        const refused = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { ip: '198.51.100.20' },
        )
        expect(refused.status).toBe(429)
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(chatMock).toHaveBeenCalledTimes(COUPON_BOX_PICK_BUDGET.perClient)
        // A different client is unaffected.
        expect(
            (
                await post(
                    { domain: freshDomain(), outline: OUTLINE },
                    { ip: '198.51.100.21' },
                )
            ).status,
        ).toBe(200)
    })

    it('cache hits are free: repeating one page never spends budget', async () => {
        const domain = freshDomain()
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.perClient * 2; i++) {
            expect(
                (
                    await post(
                        { domain, outline: OUTLINE },
                        { ip: '198.51.100.30' },
                    )
                ).status,
            ).toBe(200)
        }
        expect(chatMock).toHaveBeenCalledTimes(1)
    })
})
