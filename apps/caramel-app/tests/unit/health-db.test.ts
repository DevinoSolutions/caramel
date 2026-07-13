import { GET } from '@/app/api/health/db/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-001 — /api/health/db previously only probed the Prisma/auth DB
// (`SELECT 1`); the coupons DB (owned by the external Python verification
// service, holding the entire coupon catalog) was never checked, so an
// outage there stayed invisible to the external Uptime-Kuma monitor. This
// pins the new dual-DB contract: 200 iff BOTH DBs are up, 503 if EITHER is
// down, 401 unauthenticated — the monitor's HTTP-status-code + top-level
// `status` contract is preserved (breaking change is scoped to the JSON
// body shape only, which has no in-repo consumer).

const { queryRawMock, pingCouponsDbMock } = vi.hoisted(() => ({
    queryRawMock: vi.fn(async () => [{ '?column?': 1 }]),
    pingCouponsDbMock: vi.fn(async () => undefined),
}))

vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: queryRawMock },
}))

vi.mock('@/lib/couponsDb', () => ({
    pingCouponsDb: pingCouponsDbMock,
}))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        UPKUMA_HEALTH_SECRET: 'test-health-secret' as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

function makeRequest(headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/health/db', { headers })
}

beforeEach(() => {
    queryRawMock.mockClear()
    queryRawMock.mockImplementation(async () => [{ '?column?': 1 }])
    pingCouponsDbMock.mockClear()
    pingCouponsDbMock.mockImplementation(async () => undefined)
    envMock.UPKUMA_HEALTH_SECRET = 'test-health-secret'
})

describe('GET /api/health/db — dual-DB probe (F-001)', () => {
    it('no Authorization header -> 401, no DB checks performed', async () => {
        const res = await GET(makeRequest())
        expect(res.status).toBe(401)
        expect(queryRawMock).not.toHaveBeenCalled()
        expect(pingCouponsDbMock).not.toHaveBeenCalled()
    })

    it('UPKUMA_HEALTH_SECRET unset server-side -> 401 even with a bearer sent (fail-closed)', async () => {
        envMock.UPKUMA_HEALTH_SECRET = undefined
        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(401)
    })

    it('wrong bearer value -> 401', async () => {
        const res = await GET(makeRequest({ authorization: 'Bearer wrong' }))
        expect(res.status).toBe(401)
    })

    it('both DBs healthy -> 200, top-level status "ok", per-DB checks keyed auth_db/coupons_db', async () => {
        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('ok')
        expect(body.checks.auth_db.status).toBe('ok')
        expect(body.checks.coupons_db.status).toBe('ok')
        expect(body.checks.auth_db.service).toBe('auth_db')
        expect(body.checks.coupons_db.service).toBe('coupons_db')
        expect(queryRawMock).toHaveBeenCalledTimes(1)
        expect(pingCouponsDbMock).toHaveBeenCalledTimes(1)
    })

    it('coupons DB down -> 503, top-level status "error", auth_db unaffected (this is the F-001 gap: previously invisible)', async () => {
        pingCouponsDbMock.mockImplementation(async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:58005')
        })

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.status).toBe('error')
        expect(body.checks.auth_db.status).toBe('ok')
        expect(body.checks.coupons_db.status).toBe('error')
        expect(body.checks.coupons_db.details).toContain('ECONNREFUSED')
    })

    it('auth DB down -> 503, coupons_db unaffected', async () => {
        queryRawMock.mockImplementation(async () => {
            throw new Error('connect ETIMEDOUT')
        })

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.status).toBe('error')
        expect(body.checks.auth_db.status).toBe('error')
        expect(body.checks.coupons_db.status).toBe('ok')
    })

    it('both DBs down -> 503, both checks report error independently', async () => {
        queryRawMock.mockImplementation(async () => {
            throw new Error('auth db down')
        })
        pingCouponsDbMock.mockImplementation(async () => {
            throw new Error('coupons db down')
        })

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.checks.auth_db.status).toBe('error')
        expect(body.checks.coupons_db.status).toBe('error')
    })
})
