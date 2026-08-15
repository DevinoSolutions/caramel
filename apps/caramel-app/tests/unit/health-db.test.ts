import { GET } from '@/app/api/health/db/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/health/db probes the two data dependencies of this app: the Prisma/auth
// DB (`SELECT 1`) and the app-OWNED published coupon catalog (a Coupon
// aggregate — non-emptiness + freshness). W4-D3 retired the old external
// `coupons_db` probe (porsager couponsSql against the Python-owned
// caramel_coupons DB) and the whole local "degraded mode"; the catalog now
// lives in DATABASE_URL. Contract pinned here: 200 iff BOTH checks ok, 503 if
// EITHER fails, 401 unauthenticated. Crucially, a STALE-but-non-empty catalog
// stays 200 — staleness is an observable `stale` flag in the details, never a
// hard failure (it must not 503-flap on the static seed / bridge-sync lag);
// only an UNREACHABLE (throwing) or EMPTY (count 0) catalog is an error.

const { queryRawMock, aggregateMock } = vi.hoisted(() => ({
    queryRawMock: vi.fn(async () => [{ '?column?': 1 }]),
    // Return type widened to `updatedAt: Date | null` so the empty-catalog
    // (null) and populated (Date) mock implementations are both assignable.
    aggregateMock: vi.fn(
        async (): Promise<{
            _count: number
            _max: { updatedAt: Date | null }
        }> => ({
            _count: 30,
            _max: { updatedAt: new Date() },
        }),
    ),
}))

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRawMock,
        coupon: { aggregate: aggregateMock },
    },
}))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        UPKUMA_HEALTH_SECRET: 'test-health-secret' as string | undefined,
        // route.ts reads this at module load to build
        // CATALOG_STALE_THRESHOLD_MS — omitting it here would make that
        // constant NaN and silently break every staleness assertion below.
        CATALOG_MAX_AGE_HOURS: 48,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

function makeRequest(headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/health/db', { headers })
}

beforeEach(() => {
    queryRawMock.mockClear()
    queryRawMock.mockImplementation(async () => [{ '?column?': 1 }])
    aggregateMock.mockClear()
    aggregateMock.mockImplementation(async () => ({
        _count: 30,
        _max: { updatedAt: new Date() },
    }))
    envMock.UPKUMA_HEALTH_SECRET = 'test-health-secret'
})

describe('GET /api/health/db — auth_db + catalog probe (F-001 / W4-D3)', () => {
    it('no Authorization header -> 401, no DB checks performed', async () => {
        const res = await GET(makeRequest())
        expect(res.status).toBe(401)
        expect(queryRawMock).not.toHaveBeenCalled()
        expect(aggregateMock).not.toHaveBeenCalled()
    })

    it('UPKUMA_HEALTH_SECRET unset server-side -> 401 even with a bearer sent (fail-closed)', async () => {
        envMock.UPKUMA_HEALTH_SECRET = undefined
        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(401)
    })

    // authorize() compares in constant time (sha256-digest both sides, then
    // timingSafeEqual — mirrors rateLimit.ts's isTrustedServer). These two
    // wrong-bearer pins characterize that contract: rejection by CONTENT at the
    // same length (not merely a length check), and no throw on a DIFFERENT
    // length (raw timingSafeEqual throws on length-mismatched inputs; the
    // fixed-length digests prevent that).
    it('wrong bearer of a DIFFERENT length -> 401 (timingSafeEqual must not throw)', async () => {
        const res = await GET(makeRequest({ authorization: 'Bearer wrong' }))
        expect(res.status).toBe(401)
    })

    it('wrong bearer of the SAME length as the secret -> 401 (not merely a length check)', async () => {
        const sameLengthWrong = 'x'.repeat('test-health-secret'.length)
        expect(sameLengthWrong.length).toBe('test-health-secret'.length)
        const res = await GET(
            makeRequest({ authorization: `Bearer ${sameLengthWrong}` }),
        )
        expect(res.status).toBe(401)
    })

    it('auth_db reachable + catalog non-empty & fresh -> 200, status "ok", freshness details surfaced', async () => {
        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('ok')
        expect(body.checks.auth_db.status).toBe('ok')
        expect(body.checks.auth_db.service).toBe('auth_db')
        expect(body.checks.catalog.status).toBe('ok')
        expect(body.checks.catalog.service).toBe('catalog')
        expect(body.checks.catalog.details.count).toBe(30)
        expect(body.checks.catalog.details.stale).toBe(false)
        expect(typeof body.checks.catalog.details.freshestUpdatedAt).toBe(
            'string',
        )
        expect(typeof body.checks.catalog.details.ageMinutes).toBe('number')
        expect(queryRawMock).toHaveBeenCalledTimes(1)
        expect(aggregateMock).toHaveBeenCalledTimes(1)
    })

    it('catalog STALE but non-empty -> still 200: staleness is surfaced, never a hard failure', async () => {
        aggregateMock.mockImplementation(async () => ({
            _count: 30,
            _max: { updatedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
        }))

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('ok')
        expect(body.checks.catalog.status).toBe('ok')
        expect(body.checks.catalog.details.stale).toBe(true)
        expect(body.checks.catalog.details.ageMinutes).toBeGreaterThanOrEqual(
            4319,
        )
    })

    it('catalog EMPTY (count 0) -> 503, catalog "error", auth_db unaffected', async () => {
        aggregateMock.mockImplementation(async () => ({
            _count: 0,
            _max: { updatedAt: null },
        }))

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.status).toBe('error')
        expect(body.checks.auth_db.status).toBe('ok')
        expect(body.checks.catalog.status).toBe('error')
        expect(body.checks.catalog.details.count).toBe(0)
        expect(body.checks.catalog.details.freshestUpdatedAt).toBeNull()
        expect(body.checks.catalog.details.ageMinutes).toBeNull()
        expect(body.checks.catalog.details.stale).toBe(true)
    })

    it('catalog query THROWS (table/DB unreachable) -> 503, catalog "error" with the message in details', async () => {
        aggregateMock.mockImplementation(async () => {
            throw new Error('relation "coupons" does not exist')
        })

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.status).toBe('error')
        expect(body.checks.auth_db.status).toBe('ok')
        expect(body.checks.catalog.status).toBe('error')
        expect(typeof body.checks.catalog.details).toBe('string')
        expect(body.checks.catalog.details).toContain('does not exist')
    })

    it('auth DB down -> 503, catalog unaffected', async () => {
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
        expect(body.checks.catalog.status).toBe('ok')
    })

    it('both down -> 503, both checks report error independently', async () => {
        queryRawMock.mockImplementation(async () => {
            throw new Error('auth db down')
        })
        aggregateMock.mockImplementation(async () => {
            throw new Error('catalog db down')
        })

        const res = await GET(
            makeRequest({ authorization: 'Bearer test-health-secret' }),
        )
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.checks.auth_db.status).toBe('error')
        expect(body.checks.catalog.status).toBe('error')
    })
})
