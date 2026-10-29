import { POST } from '@/app/api/classify-cart/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-9959 (C): POST /api/classify-cart forwards `cart_items` to the LLM. A cart
// row that is really an applied-discount line ("Discount: SAVE10") carries a
// shopper's code, so the route drops discount-vocabulary rows and redacts
// mixed letter+digit tokens from the rest before classifyCart ever sees them.

// MOCK (announced): classifyCart is the paid model call; the assertion is on
// the signals the route hands it.
const { classifyMock } = vi.hoisted(() => ({
    classifyMock: vi.fn(async (_signals: { cart_items?: string[] }) => ({
        isCart: true,
    })),
}))
vi.mock('@/lib/cartClassifier', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/cartClassifier')>()),
    classifyCart: classifyMock,
}))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}))
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))
vi.mock('@/lib/rateLimit', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/rateLimit')>()),
    checkRateLimit: vi.fn(async () => null),
}))

function request(body: unknown) {
    return new NextRequest('http://localhost/api/classify-cart', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
            'cf-connecting-ip': '203.0.113.9',
        },
        body: JSON.stringify(body),
    })
}

beforeEach(() => {
    classifyMock.mockClear()
})

describe('classify-cart scrubs cart_items before the model sees them', () => {
    it('drops discount rows and redacts code-shaped tokens in the rest', async () => {
        const res = await POST(
            request({
                domain: 'shop.example.com',
                cart_items: [
                    'Discount: SAVE10',
                    'Promo applied FALL20',
                    'Blue Widget',
                    'SAVE10',
                    'Dell XPS13 Laptop',
                ],
            }),
        )

        expect(res.status).toBe(200)
        expect(classifyMock).toHaveBeenCalledTimes(1)
        const forwarded = classifyMock.mock.calls[0]![0].cart_items
        expect(forwarded).toEqual([
            'Blue Widget',
            '[code]',
            'Dell [code] Laptop',
        ])
        expect(JSON.stringify(forwarded)).not.toMatch(/SAVE10|FALL20|XPS13/)
    })

    it('still forwards a cart with no discount rows unchanged', async () => {
        await POST(
            request({
                domain: 'shop.example.com',
                cart_items: ['Blue Widget', 'Red Gadget x2'],
            }),
        )

        expect(classifyMock.mock.calls[0]![0].cart_items).toEqual([
            'Blue Widget',
            'Red Gadget x2',
        ])
    })

    it('ignores non-string rows and keeps the 6-row and 160-char caps', async () => {
        await POST(
            request({
                domain: 'shop.example.com',
                cart_items: [
                    42,
                    null,
                    'a'.repeat(300),
                    'b',
                    'c',
                    'd',
                    'e',
                    'f',
                    'g',
                ],
            }),
        )

        const forwarded = classifyMock.mock.calls[0]![0].cart_items
        expect(forwarded).toHaveLength(6)
        expect(forwarded![0]).toHaveLength(160)
    })

    it('leaves cart_items absent when the body has none', async () => {
        await POST(request({ domain: 'shop.example.com' }))

        expect(classifyMock.mock.calls[0]![0].cart_items).toBeUndefined()
    })
})
