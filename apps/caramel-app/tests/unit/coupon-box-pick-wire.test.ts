import { beforeEach, describe, expect, it, vi } from 'vitest'

// The coupon-box pick on the wire: the REAL chat() client with only fetch
// faked, so this pins what actually leaves the server — the configured model,
// temperature 0, the JSON response format, and the X-ORF-Strict header that
// pins the exact model on a relay (coupon-box-pick.test.ts fakes chat() and
// cannot see the request itself).
const { envMock } = vi.hoisted(() => ({
    envMock: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_API_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_MODEL: 'anthropic/claude-haiku-4.5',
        COUPON_BOX_LLM_ENABLED: true,
        COUPON_BOX_PICK_MODEL: 'test/box-model',
        COUPON_BOX_PICK_SECOND_MODEL: undefined as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@sentry/nextjs', () => ({
    getActiveSpan: () => undefined,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { pickCouponBox } from '@/lib/couponBoxPick'

beforeEach(() => {
    envMock.COUPON_BOX_PICK_SECOND_MODEL = undefined
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
        new Response(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            content:
                                '{"input": 7, "button": null, "toggle": null, "confidence": 80, "why": "promo field"}',
                        },
                    },
                ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
})

describe('coupon-box pick request', () => {
    it('sends X-ORF-Strict: 1 with the configured model, temperature 0, low reasoning effort and a JSON response format', async () => {
        const result = await pickCouponBox({
            domain: 'wire-test.example',
            outline: '- form:\n  - [7] textbox "Promo code"',
        })

        expect(result).toMatchObject({ outcome: 'box', input: 7 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
        const headers = init.headers as Record<string, string>
        expect(headers['X-ORF-Strict']).toBe('1')
        expect(headers['Authorization']).toBe('Bearer test-openrouter-key')
        const body = JSON.parse(init.body as string)
        expect(body).toMatchObject({
            model: 'test/box-model',
            temperature: 0,
            response_format: { type: 'json_object' },
            // At the default effort the model can reason through its whole
            // token budget and time out (smkw.com, 2026-10-13).
            reasoning_effort: 'low',
        })
        expect(body.messages[1].content).toBe(
            'Store: wire-test.example\n\n- form:\n  - [7] textbox "Promo code"',
        )
    })

    // T-19233: a free second model lets the Devino proxy answer a slow free
    // pin for free instead of paying. The header goes out only when a model is
    // configured and it is not the pin (the proxy ignores same_model).
    it.each([
        [
            'set',
            'cohere/command-a-plus-05-2026',
            'cohere/command-a-plus-05-2026',
        ],
        ['unset', undefined, undefined],
        ['the pin itself', 'test/box-model', undefined],
    ])(
        'X-ORF-Free-Second-Model when the second model is %s',
        async (label, second, expected) => {
            envMock.COUPON_BOX_PICK_SECOND_MODEL = second
            // A store of its own per case: the pick caches by (store, outline).
            await pickCouponBox({
                domain: `second-model-${label.replace(/\W+/g, '-')}.example`,
                outline: '- form:\n  - [7] textbox "Promo code"',
            })
            const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
            const headers = init.headers as Record<string, string>
            expect(headers['X-ORF-Free-Second-Model']).toBe(expected)
            expect(headers['X-ORF-Strict']).toBe('1')
        },
    )
})
