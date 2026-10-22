import { POST } from '@/app/api/coupons/[id]/report/route'
import { POST as incrementPOST } from '@/app/api/coupons/increment/route'
import { resetReportDedupeForTests } from '@/lib/couponReportDedupe'
import { attachSignals } from '@/lib/couponSignals'
import { isRecentlyFailing } from '@/lib/coupons'
import { listStoreCoupons } from '@/lib/couponsRepo'
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

function reportRequest(id: string, body: unknown, ip = '203.0.113.1') {
    return new NextRequest(`http://localhost/api/coupons/${id}/report`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': ip,
        },
        body: JSON.stringify(body),
    })
}

function incrementRequest(id: string, ip = '203.0.113.1') {
    return new NextRequest(`http://localhost/api/coupons/increment?id=${id}`, {
        method: 'POST',
        headers: {
            origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
            'cf-connecting-ip': ip,
        },
    })
}

async function cleanup() {
    // coupon_reports first: its FK to coupons is ON DELETE CASCADE, but the
    // user relation is too, and deleting in dependency order keeps this cleanup
    // honest about what it is removing rather than relying on a cascade.
    await prisma.couponReport.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.couponSignal.deleteMany({
        where: { couponId: { in: ALL_COUPON_IDS } },
    })
    await prisma.coupon.deleteMany({ where: { id: { in: ALL_COUPON_IDS } } })
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } })
}

beforeEach(async () => {
    resetReportDedupeForTests()
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

    it('a same-day repeat adds no second row and no second failure (the signed-in dedupe is per USER, whatever the IP); an anonymous report still counts once per IP', async () => {
        await POST(
            reportRequest(KNOWN_ID, { outcome: 'failed' }, '203.0.113.1'),
        )
        for (const ip of ['203.0.113.1', '203.0.113.2']) {
            const repeat = await POST(
                reportRequest(KNOWN_ID, { outcome: 'failed' }, ip),
            )
            expect(repeat.status).toBe(200)
            expect(await repeat.json()).toEqual({ ok: true, deduped: true })
        }

        // An anonymous caller behind the same IP is a different reporter.
        getSessionMock.mockImplementation(async () => null)
        const anonymous = await POST(
            reportRequest(KNOWN_ID, { outcome: 'failed' }, '203.0.113.1'),
        )
        expect(await anonymous.json()).toEqual({ ok: true })
        const anonymousAgain = await POST(
            reportRequest(KNOWN_ID, { outcome: 'failed' }, '203.0.113.1'),
        )
        expect(await anonymousAgain.json()).toEqual({ ok: true, deduped: true })

        expect(
            await prisma.couponReport.count({ where: { couponId: KNOWN_ID } }),
        ).toBe(1)
        const signal = await prisma.couponSignal.findUnique({
            where: { couponId: KNOWN_ID },
        })
        expect(signal?.failCount).toBe(2)
    })

    it('QUORUM: three distinct anonymous failed reports do not sink a code, the fourth does; forged forwarded-for headers add no reporters', async () => {
        getSessionMock.mockImplementation(async () => null)
        const failedFrom = (headers: Record<string, string>) =>
            POST(
                new NextRequest(
                    `http://localhost/api/coupons/${KNOWN_ID}/report`,
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            ...headers,
                        },
                        body: JSON.stringify({ outcome: 'failed' }),
                    },
                ),
            )
        const weight = async () =>
            (
                await prisma.couponSignal.findUniqueOrThrow({
                    where: { couponId: KNOWN_ID },
                })
            ).failWeight

        for (const n of [10, 11, 12]) {
            await failedFrom({ 'cf-connecting-ip': `203.0.113.${n}` })
        }
        expect(await weight()).toBe(3)

        // A flood of forged client headers WITHOUT the edge header is one
        // reporter, however many addresses it claims.
        for (const n of [1, 2, 3, 4, 5]) {
            await failedFrom({ 'x-forwarded-for': `198.51.100.${n}` })
        }
        expect(await weight()).toBe(4)

        const { coupons } = await listStoreCoupons(ITEST_SITE, 20)
        const row = coupons.find(c => c.id === KNOWN_ID)
        expect(row).toBeDefined()
        const [overlaid] = await attachSignals([{ id: KNOWN_ID }])
        expect(overlaid?.failWeight).toBe(4)
        expect(isRecentlyFailing(overlaid!)).toBe(true)
    })

    it('QUORUM: the honest single report still records, and does not sink', async () => {
        getSessionMock.mockImplementation(async () => null)
        const res = await POST(
            reportRequest(KNOWN_ID, { outcome: 'failed' }, '203.0.113.20'),
        )
        expect(res.status).toBe(200)
        const signal = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: KNOWN_ID },
        })
        expect(signal.failCount).toBe(1)
        expect(signal.failWeight).toBe(1)
        expect(signal.lastFailedAt).toBeInstanceOf(Date)
        expect(isRecentlyFailing(signal)).toBe(false)
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

    it('an id absent from the catalog → 404 on BOTH signal routes, with no coupon_signals row and no report row', async () => {
        const report = await POST(
            reportRequest(ABSENT_ID, { outcome: 'worked' }),
        )
        const failed = await POST(
            reportRequest(ABSENT_ID, { outcome: 'failed' }, '203.0.113.2'),
        )
        const use = await incrementPOST(incrementRequest(ABSENT_ID))

        expect(report.status).toBe(404)
        expect(failed.status).toBe(404)
        expect(use.status).toBe(404)
        expect(
            await prisma.couponReport.count({ where: { couponId: ABSENT_ID } }),
        ).toBe(0)
        // coupon_signals has no FK, so before the existence check was folded into
        // the write (INSERT ... SELECT ... WHERE EXISTS) this id got an
        // aggregate row from each of the three requests.
        expect(
            await prisma.couponSignal.findUnique({
                where: { couponId: ABSENT_ID },
            }),
        ).toBeNull()
    })

    it('a hidden (invalid) and an expired catalog row are still catalog rows: their signal is accepted', async () => {
        await prisma.coupon.update({
            where: { id: KNOWN_ID },
            data: { status: 'invalid', expired: true },
        })

        const report = await POST(
            reportRequest(KNOWN_ID, { outcome: 'failed' }),
        )
        const use = await incrementPOST(incrementRequest(KNOWN_ID))

        expect(report.status).toBe(200)
        expect(use.status).toBe(200)
        const signal = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: KNOWN_ID },
        })
        expect(signal.failCount).toBe(1)
        expect(signal.workCount).toBe(1)
    })

    it('coupon_reports carries a REAL FK while coupon_signals carries none — a direct insert for that same absent id is rejected by Postgres', async () => {
        // Why the folded existence check matters: coupon_signals is the control —
        // it takes the same unknown id without complaint, so only the gate in
        // the write keeps an arbitrary id out of it. coupon_reports, by contrast, has a real FK.
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

    it('a repeated success from one anonymous shopper moves lastWorkedAt and workCount once; another shopper still counts', async () => {
        getSessionMock.mockImplementation(async () => null)

        await POST(reportRequest(KNOWN_ID, { outcome: 'worked' }))
        await incrementPOST(incrementRequest(KNOWN_ID))
        const first = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: KNOWN_ID },
        })
        expect(first.workCount).toBe(1)

        await new Promise(resolve => setTimeout(resolve, 20))
        for (let i = 0; i < 3; i++) {
            const report = await POST(
                reportRequest(KNOWN_ID, { outcome: 'worked' }),
            )
            expect(await report.json()).toEqual({ ok: true, deduped: true })
            const use = await incrementPOST(incrementRequest(KNOWN_ID))
            expect(await use.json()).toEqual({ ok: true, deduped: true })
        }
        const repeated = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: KNOWN_ID },
        })
        expect(repeated.lastWorkedAt).toEqual(first.lastWorkedAt)
        expect(repeated.workCount).toBe(1)

        await POST(
            reportRequest(KNOWN_ID, { outcome: 'worked' }, '203.0.113.2'),
        )
        await incrementPOST(incrementRequest(KNOWN_ID, '203.0.113.2'))
        const another = await prisma.couponSignal.findUniqueOrThrow({
            where: { couponId: KNOWN_ID },
        })
        expect(another.lastWorkedAt!.getTime()).toBeGreaterThan(
            first.lastWorkedAt!.getTime(),
        )
        expect(another.workCount).toBe(2)
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
