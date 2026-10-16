import { GET, OPTIONS, dynamic } from '@/app/api/extension/features/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/extension/features — the public, keyless feature-flag read the
// extension background caches. It reports whether the server accepts
// shopper-typed codes captured at checkout, and whether the coupon-box pick
// (POST /api/extension/coupon-box-pick) is on, and whether the extension may
// find a store's promo box itself when no config describes it.
const { envMock, checkRateLimitMock } = vi.hoisted(() => ({
    envMock: {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
        COUPON_BOX_DISCOVERY_ENABLED: false,
        COUPON_BOX_LLM_ENABLED: false,
        COUPON_BOX_PICK_MODEL: undefined,
        COUPON_BOX_PICK_MODE: 'rules_first',
        COUPON_BOX_LEARNED_ENABLED: false,
        COUPON_BOX_LEARNED_SALT: undefined,
    } as Record<string, unknown>,
    checkRateLimitMock: vi.fn(async () => null as unknown),
}))

vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
        COUPON_BOX_DISCOVERY_ENABLED: false,
        COUPON_BOX_LLM_ENABLED: false,
        COUPON_BOX_PICK_MODEL: undefined,
        COUPON_BOX_PICK_MODE: 'rules_first',
        COUPON_BOX_LEARNED_ENABLED: false,
        COUPON_BOX_LEARNED_SALT: undefined,
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
    envMock.COUPON_BOX_LLM_ENABLED = false
    envMock.COUPON_BOX_PICK_MODEL = undefined
    envMock.COUPON_BOX_PICK_MODE = 'rules_first'
    envMock.COUPON_BOX_LEARNED_ENABLED = false
    envMock.COUPON_BOX_LEARNED_SALT = undefined
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
})

describe('GET /api/extension/features', () => {
    it('flag off (the code default) → { shopperCodeCapture: false }', async () => {
        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: false,
            couponBoxLlm: false,
            couponBoxPickMode: 'rules_first',
            couponBoxLearned: false,
        })
    })

    it('flag on → { shopperCodeCapture: true }', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: true,
            couponBoxDiscovery: false,
            couponBoxLlm: false,
            couponBoxPickMode: 'rules_first',
            couponBoxLearned: false,
        })
    })

    it('discovery flag on → { couponBoxDiscovery: true }, capture untouched', async () => {
        envMock.COUPON_BOX_DISCOVERY_ENABLED = true

        const res = await GET(featuresRequest())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: true,
            couponBoxLlm: false,
            couponBoxPickMode: 'rules_first',
            couponBoxLearned: false,
        })
    })

    it('couponBoxLlm is true only when enabled AND a model is configured', async () => {
        const read = async () => (await GET(featuresRequest())).json()

        envMock.COUPON_BOX_LLM_ENABLED = true
        expect((await read()).couponBoxLlm).toBe(false)

        envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
        expect(await read()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: false,
            couponBoxLlm: true,
            couponBoxPickMode: 'rules_first',
            couponBoxLearned: false,
        })

        envMock.COUPON_BOX_LLM_ENABLED = false
        expect((await read()).couponBoxLlm).toBe(false)
    })

    it.each(['llm_first', 'llm_only'] as const)(
        'couponBoxPickMode advertises %s only while couponBoxLlm is on',
        async mode => {
            const read = async () => (await GET(featuresRequest())).json()
            envMock.COUPON_BOX_PICK_MODE = mode

            // The pick is off: whatever the env says, the extension is told
            // to run the rules first, so it never asks a route that refuses.
            expect((await read()).couponBoxPickMode).toBe('rules_first')
            envMock.COUPON_BOX_LLM_ENABLED = true
            expect((await read()).couponBoxPickMode).toBe('rules_first')

            envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
            expect(await read()).toEqual({
                shopperCodeCapture: false,
                couponBoxDiscovery: false,
                couponBoxLlm: true,
                couponBoxPickMode: mode,
                couponBoxLearned: false,
            })
        },
    )

    it('couponBoxLearned is true only with its own switch AND the pick on (and a salt)', async () => {
        const read = async () => (await GET(featuresRequest())).json()
        envMock.COUPON_BOX_LEARNED_SALT = 'x'.repeat(40)

        // Its own switch on, the pick off: never advertised.
        envMock.COUPON_BOX_LEARNED_ENABLED = true
        expect((await read()).couponBoxLearned).toBe(false)

        // The pick on, its own switch off: the AI pick runs without the
        // crowd-sourced path.
        envMock.COUPON_BOX_LEARNED_ENABLED = false
        envMock.COUPON_BOX_LLM_ENABLED = true
        envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
        expect(await read()).toEqual({
            shopperCodeCapture: false,
            couponBoxDiscovery: false,
            couponBoxLlm: true,
            couponBoxPickMode: 'rules_first',
            couponBoxLearned: false,
        })

        envMock.COUPON_BOX_LEARNED_ENABLED = true
        expect((await read()).couponBoxLearned).toBe(true)
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
