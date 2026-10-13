import { GET, OPTIONS, dynamic } from '@/app/api/extension/features/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/extension/features — the public, keyless feature-flag read the
// extension background caches. Two flags: whether the server accepts
// shopper-typed codes captured at checkout, and whether the extension may find
// a store's promo box itself when no config describes it.
const { envMock, checkRateLimitMock } = vi.hoisted(() => ({
    envMock: {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
        COUPON_BOX_DISCOVERY_ENABLED: false,
    } as Record<string, unknown>,
    checkRateLimitMock: vi.fn(async () => null as unknown),
}))

vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
        COUPON_BOX_DISCOVERY_ENABLED: false,
    })
    return { ...actual, env: envMock }
})
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

function featuresRequest(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest('http://localhost/api/extension/features', {
        method: 'GET',
        headers,
    })
}

beforeEach(() => {
    envMock.SHOPPER_CODE_CAPTURE_ENABLED = false
    envMock.COUPON_BOX_DISCOVERY_ENABLED = false
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
})

describe('GET /api/extension/features', () => {
    it('both flags off (the code default) → both false', async () => {
        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: false,
        })
    })

    it('capture flag on → { shopperCodeCapture: true }', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: true,
            couponBoxDiscovery: false,
        })
    })

    it('discovery flag on → { couponBoxDiscovery: true }, capture untouched', async () => {
        envMock.COUPON_BOX_DISCOVERY_ENABLED = true

        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: true,
        })
    })

    it('needs no credentials (public read)', async () => {
        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
    })

    it('is rate-limited like any other public read', async () => {
        const { NextResponse } = await import('next/server')
        checkRateLimitMock.mockImplementation(async () =>
            NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        )

        const res = await GET(featuresRequest())

        expect(res.status).toBe(429)
        expect(checkRateLimitMock).toHaveBeenCalledWith(
            expect.anything(),
            'read',
        )
    })

    it('is force-dynamic: an env flag must never be frozen at build time or by a CDN', () => {
        expect(dynamic).toBe('force-dynamic')
    })

    it('answers a preflight (OPTIONS) with 204', async () => {
        const res = await OPTIONS(featuresRequest())

        expect(res.status).toBe(204)
    })
})
