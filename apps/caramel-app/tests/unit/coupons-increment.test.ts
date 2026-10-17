import { POST } from '@/app/api/coupons/increment/route'
import { resetReportDedupeForTests } from '@/lib/couponReportDedupe'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/coupons/increment route pins (W4-D2, RULING C′). The route no
// longer UPDATEs the external catalog's times_used — it bumps the app-owned
// coupon_signals via recordUsage(). Mock recordUsage (the app Postgres write)
// and drive the exported POST directly, mirroring coupons-report.test.ts:
// prove the /^\d{1,18}$/ id gate, that a valid call forwards the id as a STRING
// to recordUsage and returns 200 {ok:true} (no 404 — the signal is keyed
// independently of catalog-row existence), and that the origin + rate-limit
// wiring still short-circuits before anything is written.
const { recordUsageMock } = vi.hoisted(() => ({
    recordUsageMock: vi.fn(async () => undefined),
}))
vi.mock('@/lib/couponSignals', () => ({ recordUsage: recordUsageMock }))

// The route resolves an optional session (it picks the reporter the dedupe
// keys on); this stands in for the whole auth graph.
const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

// Keep the origin gate real (isExtensionOrigin: the Origin must be present and
// an extension origin); make the rate-limit round-trip controllable so a 429
// can be exercised without a real limiter.
const { checkRateLimitMock } = vi.hoisted(() => ({
    checkRateLimitMock: vi.fn(async () => null as NextResponse | null),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

function incrementRequest(opts: {
    query?: string
    body?: unknown
    /** null sends no Origin header at all. */
    origin?: string | null
    ip?: string
    bearer?: string
}) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cf-connecting-ip': opts.ip ?? '203.0.113.1',
    }
    const origin = opts.origin === undefined ? EXTENSION_ORIGIN : opts.origin
    if (origin) headers.origin = origin
    if (opts.bearer) headers.authorization = opts.bearer
    return new NextRequest(
        `http://localhost/api/coupons/increment${opts.query ?? ''}`,
        {
            method: 'POST',
            headers,
            body:
                opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
    )
}

beforeEach(() => {
    resetReportDedupeForTests()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
    recordUsageMock.mockReset()
    recordUsageMock.mockResolvedValue(undefined)
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValue(null)
})

describe('POST /api/coupons/increment — app-owned usage counter (W4-D2)', () => {
    it('valid ?id= → 200 {ok:true}, forwards the id to recordUsage as a STRING', async () => {
        const res = await POST(incrementRequest({ query: '?id=42' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(recordUsageMock).toHaveBeenCalledTimes(1)
        // A string, not the number 42 — coupon ids are strings app-side.
        expect(recordUsageMock).toHaveBeenCalledWith('42')
    })

    it('valid id in the JSON body → 200, recordUsage gets the stringified id', async () => {
        const res = await POST(incrementRequest({ body: { id: 42 } }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(recordUsageMock).toHaveBeenCalledWith('42')
    })

    it('a non-numeric id (abc) → 400, nothing recorded', async () => {
        const res = await POST(incrementRequest({ query: '?id=abc' }))

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Invalid or missing coupon ID',
        })
        expect(recordUsageMock).not.toHaveBeenCalled()
    })

    it('no id anywhere → 400, nothing recorded', async () => {
        const res = await POST(incrementRequest({ body: {} }))

        expect(res.status).toBe(400)
        expect(recordUsageMock).not.toHaveBeenCalled()
    })

    it('cross-origin request from a random website → 403 (origin gate), nothing recorded', async () => {
        const res = await POST(
            incrementRequest({
                query: '?id=42',
                origin: 'https://evil.example.com',
            }),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden origin' })
        expect(recordUsageMock).not.toHaveBeenCalled()
    })

    it('a request with no Origin, or a site Origin, is refused 403: only the extension sends uses', async () => {
        for (const origin of [null, 'http://localhost']) {
            const res = await POST(
                incrementRequest({ query: '?id=42', origin }),
            )
            expect(res.status).toBe(403)
        }
        expect(recordUsageMock).not.toHaveBeenCalled()
    })

    it('a repeated use from the SAME reporter counts once in 24h; a repeat is a 2xx no-op', async () => {
        const first = await POST(incrementRequest({ query: '?id=42' }))
        expect(await first.json()).toEqual({ ok: true })
        for (let i = 0; i < 3; i++) {
            const dup = await POST(incrementRequest({ query: '?id=42' }))
            expect(dup.status).toBe(200)
            expect(await dup.json()).toEqual({ ok: true, deduped: true })
        }
        expect(recordUsageMock).toHaveBeenCalledTimes(1)
    })

    it('honest uses from distinct reporters, or of another coupon, each count', async () => {
        await POST(incrementRequest({ query: '?id=42', ip: '198.51.100.1' }))
        await POST(incrementRequest({ query: '?id=42', ip: '198.51.100.2' }))
        await POST(incrementRequest({ query: '?id=43', ip: '198.51.100.1' }))
        expect(recordUsageMock).toHaveBeenCalledTimes(3)
    })

    it('a signed-in reporter is keyed by USER: two users behind one IP each count, one user from two IPs once', async () => {
        getSessionMock.mockResolvedValue({
            session: { id: 's1' },
            user: { id: 'user-1' },
        })
        await POST(incrementRequest({ query: '?id=42', bearer: 'Bearer a' }))
        await POST(
            incrementRequest({
                query: '?id=42',
                bearer: 'Bearer a',
                ip: '198.51.100.7',
            }),
        )
        getSessionMock.mockResolvedValue({
            session: { id: 's2' },
            user: { id: 'user-2' },
        })
        await POST(incrementRequest({ query: '?id=42', bearer: 'Bearer b' }))
        expect(recordUsageMock).toHaveBeenCalledTimes(2)
    })

    it('a failed write frees the slot: the retry is counted', async () => {
        recordUsageMock.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(incrementRequest({ query: '?id=42' }))
        expect(failed.status).toBe(500)
        const retry = await POST(incrementRequest({ query: '?id=42' }))
        expect(await retry.json()).toEqual({ ok: true })
        expect(recordUsageMock).toHaveBeenCalledTimes(2)
    })

    it('a rate-limited request → 429 (rate-limit wiring), nothing recorded', async () => {
        checkRateLimitMock.mockResolvedValueOnce(
            NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        )
        const res = await POST(incrementRequest({ query: '?id=42' }))

        expect(res.status).toBe(429)
        expect(recordUsageMock).not.toHaveBeenCalled()
    })
})
