import { POST } from '@/app/api/coupons/[id]/report/route'
import { NextRequest } from 'next/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Report-route unit pins — the app side of the trust loop (W1). Mirrors
// coupons-expire.test.ts's shape: mock the DB the signal lives in (here
// @/lib/prisma — the app Postgres, NOT the external catalog) and drive the
// exported POST with a constructed NextRequest. Proves the id is parsed from
// the PATH (withRoute doesn't thread Next's route params), that each outcome
// routes to the right recorder, and that the withRoute body gate rejects a
// bad outcome before anything is written.
//
// ANNOUNCED FAKE, not a canned mock: `coupons` and `coupon_reports` are backed
// by tiny in-memory tables below, so the route's per-day dedup and its
// catalog-existence guard are genuinely EXERCISED. A canned
// `findFirst: async () => null` would let a deleted dedup check pass every
// assertion here. The real query SHAPE is pinned separately (see "the dedup
// lookup is scoped to…"), because a fake can only ever prove the logic, never
// the SQL.
const { prismaMock, txMock, reportRows, catalogIds, getSessionMock } =
    vi.hoisted(() => {
        interface ReportRow {
            id: string
            couponId: string
            userId: string | null
            outcome: string
            createdAt: Date
        }
        const rows: ReportRow[] = []
        // Catalog ids that "exist" — coupon_reports.coupon_id carries a real FK
        // to `coupons` (coupon_signals deliberately carries none), so an id
        // absent from this set is the unknown-coupon case.
        const ids = new Set<string>()

        const signalUpsert = vi.fn(
            async (args: {
                where: { couponId: string }
                create: Record<string, unknown>
                update: Record<string, unknown>
            }) => ({ couponId: args.where.couponId }),
        )
        const txSignalUpsert = vi.fn(
            async (args: {
                where: { couponId: string }
                create: Record<string, unknown>
                update: Record<string, unknown>
            }) => ({ couponId: args.where.couponId }),
        )

        const tx = {
            couponSignal: { upsert: txSignalUpsert },
            coupon: {
                findUnique: vi.fn(async (args: { where: { id: string } }) =>
                    ids.has(args.where.id) ? { id: args.where.id } : null,
                ),
            },
            couponReport: {
                findFirst: vi.fn(
                    async (args: {
                        where: {
                            couponId: string
                            userId: string | null
                            createdAt: { gte: Date }
                        }
                    }) => {
                        const { couponId, userId, createdAt } = args.where
                        return (
                            rows.find(
                                row =>
                                    row.couponId === couponId &&
                                    row.userId === userId &&
                                    row.createdAt >= createdAt.gte,
                            ) ?? null
                        )
                    },
                ),
                create: vi.fn(
                    async (args: {
                        data: {
                            couponId: string
                            userId: string
                            outcome: string
                        }
                    }) => {
                        const row = {
                            id: `report-${rows.length + 1}`,
                            ...args.data,
                            createdAt: new Date(),
                        }
                        rows.push(row)
                        return row
                    },
                ),
            },
        }

        return {
            reportRows: rows,
            catalogIds: ids,
            txMock: tx,
            prismaMock: {
                // The anonymous path writes the signal through the singleton
                // client directly; the signed-in path writes it through `tx`.
                // Keeping the two upsert spies SEPARATE is what lets a test
                // assert which path a request actually took.
                couponSignal: { upsert: signalUpsert },
                $transaction: vi.fn(
                    async (fn: (client: typeof tx) => Promise<unknown>) =>
                        fn(tx),
                ),
            },
            getSessionMock: vi.fn(
                async (_opts: { headers: Headers }) => null as unknown,
            ),
        }
    })
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))
// withRoute lazy-imports better-auth only when a route declares `auth`; this
// stands in for the whole auth graph so the route's session resolution is
// drivable without bcrypt/prisma/email templates.
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

// Keep isOriginAllowed real (a no-Origin request passes, like the extension's
// host_permissions fetch); only the rate-limit round-trip is stubbed out.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const KNOWN_COUPON = '42'

function reportRequest(id: string, body: unknown, bearer?: string) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    }
    if (bearer !== undefined) headers.authorization = bearer
    return new NextRequest(`http://localhost/api/coupons/${id}/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    })
}

/** better-auth resolves a session for this user id on the next request(s). */
function signedInAs(userId: string) {
    getSessionMock.mockImplementation(async () => ({
        session: { id: `session-${userId}` },
        user: { id: userId },
    }))
}

/** better-auth resolves NOTHING — the anonymous case (no, garbage, or expired
 * credential all land here: getSession returns null, it does not throw). */
function anonymous() {
    getSessionMock.mockImplementation(async () => null)
}

beforeEach(() => {
    prismaMock.couponSignal.upsert.mockClear()
    prismaMock.$transaction.mockClear()
    txMock.couponSignal.upsert.mockClear()
    txMock.coupon.findUnique.mockClear()
    txMock.couponReport.findFirst.mockClear()
    txMock.couponReport.create.mockClear()
    reportRows.length = 0
    catalogIds.clear()
    catalogIds.add(KNOWN_COUPON)
    anonymous()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'))
})

afterAll(() => {
    vi.useRealTimers()
})

describe('POST /api/coupons/[id]/report — app-owned trust signal (W1)', () => {
    it('outcome "worked" → 200 {ok:true}, stamps lastWorkedAt ONLY (no workCount — increment owns that)', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = prismaMock.couponSignal.upsert.mock.calls[0]![0]
        expect(arg.where).toEqual({ couponId: KNOWN_COUPON })
        // W4-D2 split: recordWorked owns lastWorkedAt; recordUsage (POST
        // /increment) owns workCount. A "worked" report must NOT bump workCount,
        // or a successful apply (which fires BOTH report+increment) double-counts.
        expect(arg.create).toMatchObject({ couponId: KNOWN_COUPON })
        expect(arg.create.lastWorkedAt).toBeInstanceOf(Date)
        expect(arg.create).not.toHaveProperty('workCount')
        expect(arg.update.lastWorkedAt).toBeInstanceOf(Date)
        expect(arg.update).not.toHaveProperty('workCount')
    })

    it('outcome "failed" with a storeReason → 200, upserts a fail signal carrying the reason', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, {
                outcome: 'failed',
                storeReason: 'Minimum spend not met',
            }),
        )

        expect(res.status).toBe(200)
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = prismaMock.couponSignal.upsert.mock.calls[0]![0]
        expect(arg.create).toMatchObject({
            couponId: KNOWN_COUPON,
            failCount: 1,
            lastFailReason: 'Minimum spend not met',
        })
        expect(arg.update).toMatchObject({
            failCount: { increment: 1 },
            lastFailReason: 'Minimum spend not met',
        })
    })

    it('a non-numeric id (abc) → 400, nothing written', async () => {
        const res = await POST(reportRequest('abc', { outcome: 'worked' }))

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Invalid or missing coupon ID',
        })
        expect(prismaMock.couponSignal.upsert).not.toHaveBeenCalled()
    })

    it('an invalid outcome → 422 (withRoute body gate), nothing written', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'maybe' }),
        )

        expect(res.status).toBe(422)
        expect(prismaMock.couponSignal.upsert).not.toHaveBeenCalled()
    })
})

// CHARACTERIZATION — written against the pre-attribution route and required to
// stay green through it. Attribution is ADDITIVE: the anonymous request the
// extension sends today (no credential, `origin`-gated only) must behave
// byte-for-byte as it did before coupon_reports existed.
describe('POST /api/coupons/[id]/report — anonymous behavior (characterization)', () => {
    it('no credentials → 200 with the signal written, NO attributed row, and no transaction opened', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        // The signal goes through the singleton client, exactly as before.
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        // Anonymous is the extension's high-volume path: one statement, so no
        // BEGIN/COMMIT round-trip is paid for it.
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(txMock.couponReport.create).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
    })

    it('a garbage bearer is treated as anonymous — 200, never a 401, and still no attributed row', async () => {
        // better-auth returns null (it does not throw) for a garbage, revoked,
        // or expired credential, and auth: 'optional' must turn all of those
        // into "anonymous" rather than "reject". A 401 here would break every
        // extension install carrying a stale token.
        const res = await POST(
            reportRequest(
                KNOWN_COUPON,
                { outcome: 'worked' },
                'Bearer expired.garbage.token',
            ),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(txMock.couponReport.create).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
    })

    it('repeat anonymous reports are NOT deduped — every one writes the signal again', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))

        // This is the semantics the signed-in path is measured against: the
        // aggregate counter has always counted every report.
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(3)
    })

    it('an id that is well-formed but absent from the catalog still writes the signal (coupon_signals has no FK)', async () => {
        catalogIds.clear() // nothing exists in the catalog

        const res = await POST(
            reportRequest('999000404', { outcome: 'worked' }),
        )

        expect(res.status).toBe(200)
        expect(prismaMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(prismaMock.couponSignal.upsert.mock.calls[0]![0].where).toEqual({
            couponId: '999000404',
        })
    })
})

// ATTRIBUTION — what a session ADDS. Everything above still holds; a signed-in
// report writes the same aggregate signal AND one `coupon_reports` row naming
// the user, at most once per coupon per UTC day.
describe('POST /api/coupons/[id]/report — signed-in attribution (coupon_reports)', () => {
    it('a signed-in report writes the aggregate signal AND an attributed row, inside ONE transaction', async () => {
        signedInAs('user-1')

        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        // Both writes go through the SAME transaction client — a half-write
        // (signal counted, attribution lost, or the reverse) is impossible for
        // a client that will retry.
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(prismaMock.couponSignal.upsert).not.toHaveBeenCalled()
        expect(reportRows).toEqual([
            {
                id: 'report-1',
                couponId: KNOWN_COUPON,
                userId: 'user-1',
                outcome: 'worked',
                createdAt: new Date('2026-08-09T12:00:00.000Z'),
            },
        ])
    })

    it('stores the outcome verbatim — a "failed" report is attributed as failed, with the signal still carrying the reason', async () => {
        signedInAs('user-1')

        await POST(
            reportRequest(
                KNOWN_COUPON,
                { outcome: 'failed', storeReason: 'Expired code' },
                'Bearer good',
            ),
        )

        expect(reportRows[0]).toMatchObject({
            userId: 'user-1',
            outcome: 'failed',
        })
        expect(
            txMock.couponSignal.upsert.mock.calls[0]![0].create,
        ).toMatchObject({
            couponId: KNOWN_COUPON,
            failCount: 1,
            lastFailReason: 'Expired code',
        })
    })

    it('a same-day repeat is IDEMPOTENT — 200, no second row, and the aggregate signal is STILL written', async () => {
        signedInAs('user-1')

        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        vi.setSystemTime(new Date('2026-08-09T23:59:59.000Z')) // same UTC day
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(txMock.couponReport.create).toHaveBeenCalledTimes(1)
        expect(reportRows).toHaveLength(1)
        // The signal is NOT deduped — repeat anonymous reports each bump it
        // (pinned above), so signing in must not silently weaken the aggregate.
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('the SAME user reporting the SAME coupon the next UTC day is attributed again', async () => {
        signedInAs('user-1')

        vi.setSystemTime(new Date('2026-08-09T23:59:00.000Z'))
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        vi.setSystemTime(new Date('2026-08-10T00:01:00.000Z')) // 2 minutes later
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        // The window is the UTC DAY, not a rolling 24h — two minutes apart but
        // across midnight is two reports.
        expect(reportRows).toHaveLength(2)
        expect(reportRows.map(row => row.userId)).toEqual(['user-1', 'user-1'])
    })

    it('the dedup lookup is scoped to (this coupon, this user, midnight UTC) — nothing broader', async () => {
        signedInAs('user-1')
        vi.setSystemTime(new Date('2026-08-09T18:30:45.123Z'))

        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        // Pins the QUERY, not just the outcome: the in-memory fake can prove the
        // logic but never the SQL, so a window widened to "ever" or narrowed to
        // "this instant" is caught here.
        expect(txMock.couponReport.findFirst).toHaveBeenCalledTimes(1)
        expect(txMock.couponReport.findFirst.mock.calls[0]![0]).toEqual({
            where: {
                couponId: KNOWN_COUPON,
                userId: 'user-1',
                createdAt: { gte: new Date('2026-08-09T00:00:00.000Z') },
            },
            select: { id: true },
        })
    })

    it('dedup is PER USER — a different user reporting the same coupon the same day is attributed too', async () => {
        signedInAs('user-1')
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        signedInAs('user-2')
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(reportRows.map(row => row.userId)).toEqual(['user-1', 'user-2'])
    })

    it('dedup is PER COUPON — the same user reporting a different coupon the same day is attributed too', async () => {
        catalogIds.add('43')
        signedInAs('user-1')

        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        await POST(reportRequest('43', { outcome: 'worked' }, 'Bearer good'))

        expect(reportRows.map(row => row.couponId)).toEqual([
            KNOWN_COUPON,
            '43',
        ])
    })

    it('an unknown coupon id → 200 with the signal written and NO insert attempted (the FK would raise, not 500)', async () => {
        signedInAs('user-1')
        catalogIds.clear() // the id passes /^\d{1,18}$/ but no catalog row exists

        const res = await POST(
            reportRequest('999000404', { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        // Signals behavior for an unknown id is UNCHANGED (no FK on that table).
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(txMock.couponSignal.upsert.mock.calls[0]![0].where).toEqual({
            couponId: '999000404',
        })
        // The existence check runs BEFORE the insert, so the FK never fires.
        expect(txMock.coupon.findUnique).toHaveBeenCalledTimes(1)
        expect(txMock.couponReport.create).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
    })

    it('a bad id is still rejected before any session-dependent work (400, nothing written, no transaction)', async () => {
        signedInAs('user-1')

        const res = await POST(
            reportRequest('abc', { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(400)
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
    })
})
