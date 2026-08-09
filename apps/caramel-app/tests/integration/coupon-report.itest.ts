import { POST } from '@/app/api/coupons/[id]/report/route'
import prisma from '@/lib/prisma'
import { NextRequest } from 'next/server'
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// Attributed-report integration — the DB-backed sibling of
// tests/unit/coupons-report.test.ts. The unit suite drives the route against an
// in-memory fake, which can prove the LOGIC but never the SCHEMA: that
// coupon_reports.coupon_id really carries a foreign key, that the per-day
// window really is a Postgres timestamp comparison, that a real row lands with a
// real user attached. Those are exactly the facts that would make the route 500
// in production while every unit test stayed green, so they are proven here
// against the REAL prisma client + live local Postgres (:58005), catalog
// migrated (the harness/CI runs `prisma migrate deploy` first).
//
// Private id/email ranges (700071xxx coupons, a reports-itest.example site and
// user) that no seed row and no other integration file touches — see
// coupons-write.itest.ts's header for the full range map. Everything is deleted
// after each test so the suite is idempotent and re-runnable.
const KNOWN_ID = '700071001'
const OTHER_ID = '700071002'
const ABSENT_ID = '700071404' // deliberately never inserted — the FK case
const ALL_COUPON_IDS = [KNOWN_ID, OTHER_ID, ABSENT_ID]
const ITEST_SITE = 'reports-itest.example'
const USER_EMAIL = 'reports-itest@example.com'

// Only better-auth is stood in for: a real session would need a full sign-in
// round-trip, and WHICH user id the wrapper resolves is already pinned by
// withRoute's own tests. Everything below this line — prisma, the FK, the
// dedup query — is real.
const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
// The rate limiter is an in-memory bucket shared across the whole file; a suite
// that posts a dozen reports would trip it on request count alone, which proves
// nothing about attribution. Origin gating stays REAL.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

let userId = ''

async function insertCoupon(id: string) {
    await prisma.coupon.create({
        data: {
            id,
            code: `REPORT-ITEST-${id}`,
            site: ITEST_SITE,
            title: 'reports itest coupon',
            description: 'synthetic row for the attributed-report itest',
            // NOT 'valid' — stays out of coupons-read.itest.ts's status='valid'
            // census.
            status: 'pending',
        },
    })
}

function reportRequest(id: string, body: unknown) {
    return new NextRequest(`http://localhost/api/coupons/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

async function cleanup() {
    // coupon_reports first: its FK to coupons is ON DELETE CASCADE, but the
    // user relation is too, and deleting in dependency order keeps this cleanup
    // honest about what it is removing rather than relying on a cascade.
    await prisma.couponReport.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.coupon.deleteMany({ where: { id: { in: ALL_COUPON_IDS } } })
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } })
}

beforeEach(async () => {
    await cleanup()
    const user = await prisma.user.create({ data: { email: USER_EMAIL } })
    userId = user.id
    getSessionMock.mockImplementation(async () => ({
        session: { id: 'itest-session' },
        user: { id: userId },
    }))
    await insertCoupon(KNOWN_ID)
})

afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('POST /api/coupons/[id]/report — attribution against real pg :58005', () => {
    it('a signed-in report lands one coupon_reports row carrying the real user id, alongside the aggregate signal', async () => {
        const res = await POST(reportRequest(KNOWN_ID, { outcome: 'worked' }))
        expect(res.status).toBe(200)

        const reports = await prisma.couponReport.findMany({
            where: { couponId: KNOWN_ID },
        })
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({
            couponId: KNOWN_ID,
            userId,
            outcome: 'worked',
        })
        expect(reports[0]!.createdAt).toBeInstanceOf(Date)

        const signal = await prisma.couponSignal.findUnique({
            where: { couponId: KNOWN_ID },
        })
        expect(signal?.lastWorkedAt).toBeInstanceOf(Date)
    })

    it('a same-day repeat adds no second row but DOES bump the aggregate again', async () => {
        await POST(reportRequest(KNOWN_ID, { outcome: 'failed' }))
        const res = await POST(reportRequest(KNOWN_ID, { outcome: 'failed' }))
        expect(res.status).toBe(200)

        expect(
            await prisma.couponReport.count({ where: { couponId: KNOWN_ID } }),
        ).toBe(1)
        // Repeat ANONYMOUS reports have always each bumped failCount; the
        // signed-in path matches that rather than silently weakening the
        // aggregate for users who sign in.
        const signal = await prisma.couponSignal.findUnique({
            where: { couponId: KNOWN_ID },
        })
        expect(signal?.failCount).toBe(2)
    })

    it('a report already stored YESTERDAY does not block today (the window is the UTC day, not "ever")', async () => {
        // Backdated directly so the check is exercised against Postgres's own
        // timestamp comparison rather than a faked clock.
        await prisma.couponReport.create({
            data: {
                couponId: KNOWN_ID,
                userId,
                outcome: 'worked',
                createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
            },
        })

        await POST(reportRequest(KNOWN_ID, { outcome: 'worked' }))

        expect(
            await prisma.couponReport.count({ where: { couponId: KNOWN_ID } }),
        ).toBe(2)
    })

    it('an id absent from the catalog → 200 with the signal written and NO report row (the FK is real)', async () => {
        const res = await POST(reportRequest(ABSENT_ID, { outcome: 'worked' }))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(
            await prisma.couponReport.count({ where: { couponId: ABSENT_ID } }),
        ).toBe(0)
        // Unchanged from before attribution existed: coupon_signals has no FK,
        // so an unknown id still gets its aggregate row.
        const signal = await prisma.couponSignal.findUnique({
            where: { couponId: ABSENT_ID },
        })
        expect(signal?.lastWorkedAt).toBeInstanceOf(Date)
    })

    it('the FK the route precheck exists for is REAL — a direct insert for that same absent id is rejected by Postgres', async () => {
        // Red-proof for the precheck: without it the route would hand this exact
        // insert to the driver and the request would 500. coupon_signals is the
        // control — it takes the same unknown id without complaint.
        await expect(
            prisma.couponReport.create({
                data: { couponId: ABSENT_ID, userId, outcome: 'worked' },
            }),
        ).rejects.toThrow()

        await expect(
            prisma.couponSignal.create({ data: { couponId: ABSENT_ID } }),
        ).resolves.toMatchObject({ couponId: ABSENT_ID })
    })

    it('dedup is per (user, coupon) — the same user reporting another coupon the same day is attributed', async () => {
        await insertCoupon(OTHER_ID)

        await POST(reportRequest(KNOWN_ID, { outcome: 'worked' }))
        await POST(reportRequest(OTHER_ID, { outcome: 'worked' }))

        const reports = await prisma.couponReport.findMany({
            where: { couponId: { in: [KNOWN_ID, OTHER_ID] } },
            orderBy: { couponId: 'asc' },
        })
        expect(reports.map(report => report.couponId)).toEqual([
            KNOWN_ID,
            OTHER_ID,
        ])
    })

    it('an anonymous report writes the signal and NOTHING to coupon_reports', async () => {
        getSessionMock.mockImplementation(async () => null)

        const res = await POST(reportRequest(KNOWN_ID, { outcome: 'worked' }))

        expect(res.status).toBe(200)
        expect(
            await prisma.couponReport.count({ where: { couponId: KNOWN_ID } }),
        ).toBe(0)
        const signal = await prisma.couponSignal.findUnique({
            where: { couponId: KNOWN_ID },
        })
        expect(signal?.lastWorkedAt).toBeInstanceOf(Date)
    })
})
