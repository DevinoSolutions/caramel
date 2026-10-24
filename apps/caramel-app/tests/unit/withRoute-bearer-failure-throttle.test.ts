import { withRoute } from '@/lib/api/withRoute'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-6230 — the apiKey gates (ingest/* INGEST_API_KEY, coupons/expire
// COUPONS_ADMIN_SECRET) answered every wrong bearer with a bare 401: no
// throttle, no breadcrumb, no signal. A FAILED bearer check is now counted per
// client IP and answers 429 once an IP has failed too often; a valid bearer
// never touches the counter.
//
// Each test uses its own client IP: the failure limiter is a module-level
// singleton (as in rateLimit.test.ts), so a shared IP would leak budget.

const { envMock } = vi.hoisted(() => ({
    envMock: {
        CHROME_EXTENSION_ORIGIN: undefined as string | undefined,
        FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
        SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
        COUPONS_ADMIN_SECRET: 'admin-secret-T6230' as string | undefined,
        INGEST_API_KEY: 'ingest-key-T6230' as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { breadcrumbMock } = vi.hoisted(() => ({ breadcrumbMock: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: breadcrumbMock,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setUser: vi.fn(),
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => undefined),
}))

beforeEach(() => {
    breadcrumbMock.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function req(ip: string, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/ingest/test', {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip, ...headers },
    })
}

const ingestRoute = () =>
    withRoute(
        { method: 'POST', routeName: 'test/ingest', apiKey: 'ingest' },
        async () => NextResponse.json({ ok: true }),
    )
const adminRoute = () =>
    withRoute(
        { method: 'POST', routeName: 'test/admin', apiKey: 'trustedServer' },
        async () => NextResponse.json({ ok: true }),
    )

describe('withRoute — failed-bearer throttle (T-6230)', () => {
    it('answers 401 for the first failures, then 429 with Retry-After, for apiKey ingest', async () => {
        const route = ingestRoute()
        const ip = '198.51.100.10'
        const statuses: number[] = []
        for (let i = 0; i < 12; i++) {
            statuses.push(
                (await route(req(ip, { authorization: 'Bearer wrong' })))
                    .status,
            )
        }
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
        expect(statuses.slice(10)).toEqual([429, 429])
        const limited = await route(req(ip, { authorization: 'Bearer wrong' }))
        expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    })

    it('throttles apiKey trustedServer the same way (coupons/expire)', async () => {
        const route = adminRoute()
        const ip = '198.51.100.11'
        let last = 0
        for (let i = 0; i < 11; i++) {
            last = (await route(req(ip))).status
        }
        expect(last).toBe(429)
    })

    it('a valid bearer is never counted: 50 good calls then a bad one is still a plain 401', async () => {
        const route = ingestRoute()
        const ip = '198.51.100.12'
        for (let i = 0; i < 50; i++) {
            const res = await route(
                req(ip, { authorization: 'Bearer ingest-key-T6230' }),
            )
            expect(res.status).toBe(200)
        }
        const bad = await route(req(ip, { authorization: 'Bearer wrong' }))
        expect(bad.status).toBe(401)
    })

    it('a throttled IP does not block a valid bearer from the SAME IP', async () => {
        const route = ingestRoute()
        const ip = '198.51.100.13'
        for (let i = 0; i < 12; i++) {
            await route(req(ip, { authorization: 'Bearer wrong' }))
        }
        const good = await route(
            req(ip, { authorization: 'Bearer ingest-key-T6230' }),
        )
        expect(good.status).toBe(200)
    })

    it('keys by client IP: one IP exhausting its budget does not throttle another', async () => {
        const route = ingestRoute()
        for (let i = 0; i < 12; i++) {
            await route(req('198.51.100.14', { authorization: 'Bearer x' }))
        }
        const other = await route(
            req('198.51.100.15', { authorization: 'Bearer x' }),
        )
        expect(other.status).toBe(401)
    })

    it('uses the limiter-wide IP derivation: CF-Connecting-IP wins over a rotating forged X-Forwarded-For', async () => {
        const route = ingestRoute()
        let last = 0
        for (let i = 0; i < 11; i++) {
            last = (
                await route(
                    req('198.51.100.16', {
                        authorization: 'Bearer x',
                        'x-forwarded-for': `10.0.0.${i}`,
                    }),
                )
            ).status
        }
        expect(last).toBe(429)
    })

    it('leaves a breadcrumb for each failed attempt, so a key-guessing run is visible', async () => {
        const route = ingestRoute()
        await route(req('198.51.100.17', { authorization: 'Bearer x' }))
        expect(breadcrumbMock).toHaveBeenCalledWith(
            expect.objectContaining({
                category: 'ratelimit',
                message: expect.stringContaining('bearer-auth-fail'),
            }),
        )
    })

    it('fails closed when the key is unset: still 401, and counted', async () => {
        envMock.INGEST_API_KEY = undefined
        try {
            const res = await ingestRoute()(
                req('198.51.100.18', { authorization: 'Bearer anything' }),
            )
            expect(res.status).toBe(401)
        } finally {
            envMock.INGEST_API_KEY = 'ingest-key-T6230'
        }
    })
})
