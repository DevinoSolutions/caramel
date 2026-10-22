import { POST } from '@/app/api/classify-cart/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/classify-cart checked only the DECLARED Content-Length and then
// read the whole body with req.json(). A chunked body carries no
// Content-Length, so it was read whole, however large, before anything
// measured it. The route now reads no further than its 8 KiB cap.

// MOCK (announced): classifyCart is the paid model call; it must never run on
// a refused body, and answers a fixed result for the one body that passes.
const { classifyMock } = vi.hoisted(() => ({
    classifyMock: vi.fn(async () => ({ isCart: true })),
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

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const HEADERS = {
    'content-type': 'application/json',
    origin: EXT_ORIGIN,
    'cf-connecting-ip': '203.0.113.7',
}

function request(body: BodyInit, headers: Record<string, string> = {}) {
    return new NextRequest(
        new Request('http://localhost/api/classify-cart', {
            method: 'POST',
            headers: { ...HEADERS, ...headers },
            body,
            duplex: 'half',
        } as RequestInit),
    )
}

beforeEach(() => {
    classifyMock.mockClear()
})

describe('classify-cart reads its body only up to the cap', () => {
    it('refuses a chunked body with no Content-Length, and stops reading at the cap', async () => {
        // 1 MiB offered in 1 KiB chunks, pulled only as the route reads.
        let pulled = 0
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1
                if (pulled > 1024) controller.close()
                else controller.enqueue(new Uint8Array(1024).fill(0x20))
            },
        })
        const res = await POST(request(stream))
        expect(res.status).toBe(413)
        // The 8 KiB cap is passed on the 9th chunk; a few more may be
        // buffered ahead, never the whole body.
        expect(pulled).toBeLessThan(30)
        expect(classifyMock).not.toHaveBeenCalled()
    })

    it('still refuses a declared Content-Length over the cap', async () => {
        const res = await POST(
            request('{}', { 'content-length': String(64 * 1024) }),
        )
        expect(res.status).toBe(413)
        expect(classifyMock).not.toHaveBeenCalled()
    })

    it('answers 400 for a body that is not JSON', async () => {
        const res = await POST(request('not json'))
        expect(res.status).toBe(400)
        expect(classifyMock).not.toHaveBeenCalled()
    })

    it('still classifies a valid body under the cap', async () => {
        const res = await POST(
            request(
                JSON.stringify({
                    domain: 'shop.example.com',
                    url: 'https://shop.example.com/cart',
                    title: 'Your cart',
                }),
            ),
        )
        expect(res.status).not.toBe(413)
        expect(res.status).not.toBe(400)
        expect(classifyMock).toHaveBeenCalledTimes(1)
    })
})
