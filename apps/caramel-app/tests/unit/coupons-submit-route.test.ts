import { POST } from '@/app/api/coupons/submit/route'
import { ShopperSubmissionLimitError } from '@/lib/shopperCoupons'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/coupons/submit — the route a signed-in shopper's code travels
// through, from the website form (cookie session, same origin) AND from the
// extension background (bearer token). The data layer (submitShopperCoupon) and
// the trust signal (recordWorked) are mocked: their own behavior is pinned in
// shopper-coupons.test.ts / couponsRepo.test.ts / the integration suite. What
// this file pins is the ROUTE's contract: the gates, the status codes, and the
// one rule that separates the two sources (only a checkout capture, where the
// store itself accepted the code, stamps "worked").
const {
    envMock,
    getSessionMock,
    submitShopperCouponMock,
    recordWorkedMock,
    checkRateLimitMock,
} = vi.hoisted(() => ({
    envMock: { SHOPPER_CODE_CAPTURE_ENABLED: false } as Record<string, unknown>,
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
    submitShopperCouponMock: vi.fn(
        async (_args: {
            base: string
            code: string
            source: 'checkout' | 'manual'
            userId: string
        }) => ({ couponId: '900000000000000001', created: true }),
    ),
    recordWorkedMock: vi.fn(async (_couponId: string) => {}),
    checkRateLimitMock: vi.fn(async () => null as unknown),
}))

// The real env (withRoute and rateLimit read it too) with the capture flag
// overridable per test.
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
    })
    return { ...actual, env: envMock }
})
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/couponsRepo', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    submitShopperCoupon: submitShopperCouponMock,
}))
vi.mock('@/lib/couponSignals', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordWorked: recordWorkedMock,
}))
// isOriginAllowed stays real; only the rate-limit round trip is stubbed.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

function submitRequest(
    body: unknown,
    headers: Record<string, string> = {},
): NextRequest {
    return new NextRequest('http://localhost/api/coupons/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

function signedInAs(userId: string) {
    getSessionMock.mockImplementation(async () => ({
        session: { id: `session-${userId}` },
        user: { id: userId },
    }))
}

beforeEach(() => {
    envMock.SHOPPER_CODE_CAPTURE_ENABLED = false
    getSessionMock.mockReset()
    getSessionMock.mockImplementation(async () => null)
    submitShopperCouponMock.mockReset()
    submitShopperCouponMock.mockImplementation(async () => ({
        couponId: '900000000000000001',
        created: true,
    }))
    recordWorkedMock.mockReset()
    recordWorkedMock.mockImplementation(async () => {})
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
})

describe('POST /api/coupons/submit — gates', () => {
    it('no session → 401, nothing written', async () => {
        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(401)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('a cross-origin browser request → 403 before the session is even read', async () => {
        signedInAs('user-1')

        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'https://evil.example', host: 'localhost' },
            ),
        )

        expect(res.status).toBe(403)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it('an extension-origin request is allowed through the origin gate', async () => {
        signedInAs('user-1')

        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'chrome-extension://abcdefghijklmnop' },
            ),
        )

        expect(res.status).toBe(200)
    })

    it('a rate-limited caller → the limiter response, nothing written', async () => {
        signedInAs('user-1')
        const { NextResponse } = await import('next/server')
        checkRateLimitMock.mockImplementation(async () =>
            NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        )

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(429)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/coupons/submit — validation', () => {
    beforeEach(() => signedInAs('user-1'))

    it.each([
        [
            'an unknown source',
            { site: 'ebay.com', code: 'SAVE10', source: 'bot' },
        ],
        ['a missing site', { code: 'SAVE10', source: 'manual' }],
        ['an empty site', { site: '', code: 'SAVE10', source: 'manual' }],
        [
            'a site over 253 chars',
            { site: 'a'.repeat(254), code: 'SAVE10', source: 'manual' },
        ],
        ['a missing code', { site: 'ebay.com', source: 'manual' }],
        [
            'a non-string code',
            { site: 'ebay.com', code: 12345, source: 'manual' },
        ],
    ])('%s → 422 (body schema), nothing written', async (_label, body) => {
        const res = await POST(submitRequest(body))

        expect(res.status).toBe(422)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it.each([
        ['too short', 'ab'],
        ['contains spaces', 'a b c'],
        ['markup', '<script>'],
        ['over 40 chars', 'A'.repeat(41)],
        ['blank', '   '],
    ])(
        'a code that is %s → 422 invalid-code, nothing written',
        async (_l, code) => {
            const res = await POST(
                submitRequest({ site: 'ebay.com', code, source: 'manual' }),
            )

            expect(res.status).toBe(422)
            expect(await res.json()).toEqual({ error: 'invalid-code' })
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
        },
    )

    it.each(['co.uk', 'localhost', 'not a host', 'foo.example'])(
        'a site that names no registrable store (%s) → 422 not-a-store, nothing written',
        async site => {
            const res = await POST(
                submitRequest({ site, code: 'SAVE10', source: 'manual' }),
            )

            expect(res.status).toBe(422)
            expect(await res.json()).toEqual({ error: 'not-a-store' })
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
        },
    )
})

describe('POST /api/coupons/submit — manual source', () => {
    beforeEach(() => signedInAs('user-1'))

    it('submits for the RESOLVED base domain, returns Unverified, and never stamps "worked"', async () => {
        const res = await POST(
            submitRequest({
                site: 'WWW.Shop.eBay.com',
                code: '  SAVE10 ',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '900000000000000001',
            created: true,
            status: 'unverified',
        })
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
        // base = the registrable domain (what the store page canonicalizes
        // to); the code is the trimmed one, case untouched; userId is users.id.
        expect(submitShopperCouponMock).toHaveBeenCalledWith({
            base: 'ebay.com',
            code: 'SAVE10',
            source: 'manual',
            userId: 'user-1',
        })
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('works with the capture flag OFF (the flag gates checkout capture only)', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
    })

    it('a duplicate (created:false) is still a 200 and reports the existing id', async () => {
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '42',
            created: false,
        }))

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '42',
            created: false,
            status: 'unverified',
        })
    })
})

describe('POST /api/coupons/submit — checkout source', () => {
    beforeEach(() => signedInAs('user-1'))

    it('flag OFF → 403 capture-disabled, and neither the repo nor recordWorked is touched', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
            }),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'capture-disabled' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('flag ON → submits, then stamps the coupon "worked", and returns status worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({
                site: 'checkout.ebay.com',
                code: 'SAVE10',
                source: 'checkout',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '900000000000000001',
            created: true,
            status: 'worked',
        })
        expect(submitShopperCouponMock).toHaveBeenCalledWith({
            base: 'ebay.com',
            code: 'SAVE10',
            source: 'checkout',
            userId: 'user-1',
        })
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(recordWorkedMock).toHaveBeenCalledWith('900000000000000001')
        // The write order matters: the row must exist before it is stamped.
        expect(
            submitShopperCouponMock.mock.invocationCallOrder[0]!,
        ).toBeLessThan(recordWorkedMock.mock.invocationCallOrder[0]!)
    })

    it('flag ON, duplicate of an existing coupon → still stamps THAT coupon worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '42',
            created: false,
        }))

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '42',
            created: false,
            status: 'worked',
        })
        expect(recordWorkedMock).toHaveBeenCalledWith('42')
    })

    it('a recordWorked failure is NOT swallowed: the route fails (500) rather than reporting a stamp that never landed', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        recordWorkedMock.mockImplementation(async () => {
            throw new Error('signals table unavailable')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
            }),
        )

        expect(res.status).toBe(500)
        errorSpy.mockRestore()
    })
})

describe('POST /api/coupons/submit — failures', () => {
    beforeEach(() => signedInAs('user-1'))

    it('ShopperSubmissionLimitError → 429 daily-limit', async () => {
        submitShopperCouponMock.mockImplementation(async () => {
            throw new ShopperSubmissionLimitError()
        })

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({ error: 'daily-limit' })
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('any other repo error → 500 through handleRouteError (not swallowed)', async () => {
        submitShopperCouponMock.mockImplementation(async () => {
            throw new Error('connection reset')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(500)
        expect(recordWorkedMock).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })
})
