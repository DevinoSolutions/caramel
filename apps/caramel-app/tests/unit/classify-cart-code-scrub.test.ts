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

    // Each row is the ONLY cart item, sent through the production route.
    // You-saved lines hold no code; the rule drops them anyway (uniform rule).
    it.each([
        ['Discount: SAVE10', []],
        ['Discount -$5.00', []],
        ['Promo code SAVE10 applied', []],
        ['Promo code WELCOME applied', []],
        ['Coupon: WELCOME!', []],
        ['Coupon: WELCOME.', []],
        ['Voucher - FALL20', []],
        ['  • Coupon code: FALL20', []],
        ['Savings ($5.00)', []],
        ['Discount −5%', []],
        ['-$5.00', []],
        ['($5.00)', []],
        ['Code applied: X', []],
        ['Promo applied FALL20', []],
        ['You saved $5', []],
        ['Discount applied', []],
        ['Coupon applied', []],
        ['Savings planner $12.99', ['Savings planner $12.99']],
        ['Coupon organizer - $8', ['Coupon organizer - $8']],
        ['Savings planner Qty: 2 $12.99', ['Savings planner Qty: 2 $12.99']],
        ['Promontory hiking boots $89', ['Promontory hiking boots $89']],
        ['Promo-pack bundle', ['Promo-pack bundle']],
        ['Quantity: 2', ['Quantity: 2']],
        [
            'Coupon organizer with applied floral print',
            ['Coupon organizer with applied floral print'],
        ],
        ['Gift voucher holder', ['Gift voucher holder']],
    ])('cart row %j -> %j', async (row, expected) => {
        await POST(request({ domain: 'shop.example.com', cart_items: [row] }))

        expect(classifyMock.mock.calls[0]![0].cart_items).toEqual(expected)
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

    it('scrubs BEFORE the 6-row cap: discount rows ahead of the 6th product do not take a slot', async () => {
        await POST(
            request({
                domain: 'shop.example.com',
                cart_items: [
                    'Discount: SAVE10',
                    'Coupon FALL20 applied',
                    'Savings: 10%',
                    'p1',
                    'p2',
                    'p3',
                    'p4',
                    'p5',
                    'p6',
                    'p7',
                ],
            }),
        )

        expect(classifyMock.mock.calls[0]![0].cart_items).toEqual([
            'p1',
            'p2',
            'p3',
            'p4',
            'p5',
            'p6',
        ])
    })

    it('redacts a mixed token that would cross the 160-char cut', async () => {
        const row = `${'x'.repeat(156)} SAVE1234`
        await POST(request({ domain: 'shop.example.com', cart_items: [row] }))

        const forwarded = classifyMock.mock.calls[0]![0].cart_items![0]!
        expect(forwarded).toHaveLength(160)
        expect(forwarded).toBe(`${'x'.repeat(156)} [co`)
        expect(forwarded).not.toMatch(/SAV|1234/)
    })

    it('leaves cart_items absent when the body has none', async () => {
        await POST(request({ domain: 'shop.example.com' }))

        expect(classifyMock.mock.calls[0]![0].cart_items).toBeUndefined()
    })
})
