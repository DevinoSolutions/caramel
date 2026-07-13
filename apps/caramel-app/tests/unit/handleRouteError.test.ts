import { GET as couponsGET } from '@/app/api/coupons/route'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-002 — closes the "caught route errors never reach Sentry" gap.
// instrumentation.ts's onRequestError already handles UNCAUGHT errors; this
// helper is for the pervasive try/catch-return-500 sites that previously
// swallowed the error entirely (see PLAN-F-002.md §Test strategy).
const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
}))

// Used only by the coupons/route.ts integration pin below — always-throws
// so the route's try block reliably reaches its catch site. importActual
// keeps visibleCouponsWhere/rankingOrderSql (real, unmocked — safe, they
// only ever build a lazy fragment, never execute it standalone — see
// coupons-visibility.test.ts's closure-timing note) wired: couponsRepo.ts's
// listCoupons() calls visibleCouponsWhere() BEFORE ever touching couponsSql,
// so without importActual that call itself throws first (a real, different
// error than "db exploded") — the route's try/catch still reaches the
// same 500 either way, but importActual keeps this pin testing the thing
// its name says it tests.
vi.mock('@/lib/couponsDb', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/couponsDb')>(
            '@/lib/couponsDb',
        )
    return {
        ...actual,
        couponsSql: () => {
            throw new Error('db exploded')
        },
    }
})
vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
}))

beforeEach(() => {
    captureExceptionMock.mockClear()
})

describe('handleRouteError', () => {
    it('reports to Sentry tagged with route/method/requestId, and returns {error} at the given status with an x-request-id header', async () => {
        const req = new NextRequest('http://localhost/api/coupons?x=1', {
            method: 'GET',
        })
        const err = new Error('boom')

        const res = handleRouteError(err, {
            req,
            message: 'Error fetching coupons.',
            status: 500,
        })

        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [capturedErr, context] = captureExceptionMock.mock.calls[0]
        expect(capturedErr).toBe(err)
        expect(context.tags.route).toBe('/api/coupons')
        expect(context.tags.method).toBe('GET')
        expect(context.tags.requestId).toEqual(expect.any(String))

        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Error fetching coupons.' })
        expect(res.headers.get('x-request-id')).toBe(context.tags.requestId)
    })

    it('defaults to status 500 and a generic message when neither is given', async () => {
        const res = handleRouteError(new Error('x'))
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Internal server error' })
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
    })

    it('honors an explicit status override (e.g. 502)', async () => {
        const res = handleRouteError(new Error('x'), {
            status: 502,
            message: 'upstream failed',
        })
        expect(res.status).toBe(502)
    })

    it('accepts an explicit route tag when no req is available', () => {
        handleRouteError(new Error('x'), { route: '/api/custom' })
        const [, context] = captureExceptionMock.mock.calls[0]
        expect(context.tags.route).toBe('/api/custom')
        expect(context.tags.method).toBeUndefined()
    })

    it('merges extra headers (e.g. CORS) with x-request-id rather than dropping them', () => {
        const res = handleRouteError(new Error('x'), {
            headers: { 'Access-Control-Allow-Origin': 'https://example.com' },
        })
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'https://example.com',
        )
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
    })
})

// Proves the mechanism end-to-end through a real route: a caught DB error
// now reaches Sentry instead of vanishing into a plain 500 (the Critical
// gap this finding exists for). coupons/route.ts is the representative
// site; the other 13 catch sites get the identical mechanical conversion.
describe('coupons/route.ts — caught errors now reach Sentry (F-002 integration pin)', () => {
    it('DB failure -> {error: "Error fetching coupons."} + 500 AND Sentry.captureException is called', async () => {
        const res = await couponsGET(
            new NextRequest('http://localhost/api/coupons'),
        )

        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'Error fetching coupons.' })
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        expect(res.headers.get('x-request-id')).toEqual(expect.any(String))
    })
})
