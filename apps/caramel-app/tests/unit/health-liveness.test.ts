import { GET } from '@/app/api/health/route'
import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

// GET /api/health is the compose `web` healthcheck target — a LIVENESS
// probe that decides whether Traefik keeps routing to the container. Its
// whole contract is "cheap and independent": 200 with no auth, no rate
// limit, no DB, and never cacheable. The 2026-08/09 outage streak was a
// probe that depended on homepage latency; these pin the properties that
// make this one safe to route on.

const { checkRateLimitMock } = vi.hoisted(() => ({
    checkRateLimitMock: vi.fn(),
}))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: checkRateLimitMock }))

// If the route ever imported prisma, this mock would surface it as a call.
const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))

describe('GET /api/health — container liveness probe', () => {
    it('answers 200 {status:"ok"} with no headers at all (no bearer, no origin)', async () => {
        const res = await GET(
            new NextRequest('http://127.0.0.1:3000/api/health'),
        )
        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ status: 'ok' })
    })

    it('is never rate-limited and never touches the database', async () => {
        await GET(new NextRequest('http://127.0.0.1:3000/api/health'))
        expect(checkRateLimitMock).not.toHaveBeenCalled()
        expect(queryRawMock).not.toHaveBeenCalled()
    })

    it('is no-store so no proxy/edge ever answers the probe for the container', async () => {
        const res = await GET(
            new NextRequest('http://127.0.0.1:3000/api/health'),
        )
        expect(res.headers.get('cache-control')).toBe('no-store')
    })
})
