import { POST } from '@/app/api/coupons/[id]/report/route'
import { resetReportDedupeForTests } from '@/lib/couponReportDedupe'
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
// catalog-existence gate (couponsRepo.couponExists, a `$queryRaw` whose composed
// `.sql` is asserted below) are genuinely EXERCISED. A canned
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
        // Catalog ids that "exist" — coupon_signals deliberately carries no FK
        // to `coupons`, so the route gates on couponExists; an id absent from
        // this set is the unknown-coupon case (404, nothing written).
        const ids = new Set<string>()

        const txSignalUpsert = vi.fn(
            async (args: {
                where: { couponId: string }
                create: Record<string, unknown>
                update: Record<string, unknown>
            }) => ({ couponId: args.where.couponId, failWeight: 0 }),
        )

        const tx = {
            // recordFailed's quorum bookkeeping (couponSignals.ts). This file
            // pins the ROUTE's wiring, so these are canned test doubles; the
            // quorum arithmetic itself is pinned in coupon-failure-quorum.test.ts
            // against an in-memory reporters table, and in the integration suite
            // against real Postgres.
            couponSignal: {
                upsert: txSignalUpsert,
                update: vi.fn(async () => ({})),
            },
            couponSignalReporter: {
                findMany: vi.fn(async () => []),
                upsert: vi.fn(async () => ({})),
                aggregate: vi.fn(async () => ({ _sum: { weight: 1 } })),
                deleteMany: vi.fn(async () => ({ count: 0 })),
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
                // couponExists: the id is the first bound value of the composed
                // Prisma.sql, the answer is the `known` column.
                $queryRaw: vi.fn(
                    async (query: { sql: string; values: unknown[] }) => [
                        { known: ids.has(String(query.values[0])) },
                    ],
                ),
                // Both paths write the signal through a transaction client (the
                // writers wrap their own quorum bookkeeping in one); the only
                // difference between them is the coupon_reports attribution row.
                // The global retention sweep goes through the singleton client.
                couponSignalReporter: {
                    deleteMany: vi.fn(async () => ({ count: 0 })),
                },
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

function reportRequest(
    id: string,
    body: unknown,
    bearer?: string,
    ip = '203.0.113.1',
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
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
    resetReportDedupeForTests()
    prismaMock.$transaction.mockClear()
    prismaMock.$queryRaw.mockClear()
    txMock.couponSignal.upsert.mockClear()
    txMock.couponReport.findFirst.mockClear()
    txMock.couponReport.create.mockClear()
    reportRows.length = 0
    catalogIds.clear()
    catalogIds.add(KNOWN_COUPON)
    catalogIds.add('43')
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
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = txMock.couponSignal.upsert.mock.calls[0]![0]
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
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        const arg = txMock.couponSignal.upsert.mock.calls[0]![0]
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
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()
    })

    it('an invalid outcome → 422 (withRoute body gate), nothing written', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'maybe' }),
        )

        expect(res.status).toBe(422)
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()
    })
})

// CHARACTERIZATION — written against the pre-attribution route and required to
// stay green through it. Attribution is ADDITIVE: the anonymous request the
// extension sends today (no credential, `origin`-gated only) must behave
// byte-for-byte as it did before coupon_reports existed.
describe('POST /api/coupons/[id]/report — anonymous behavior (characterization)', () => {
    it('no credentials → 200 with the signal written, NO attributed row, and only the writers own transaction', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        // The writer wraps its own bookkeeping in ONE transaction, and nothing
        // else: no coupon_reports row, no second transaction.
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
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
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(txMock.couponReport.create).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
    })

    it('a repeated WORKED report from the SAME IP moves lastWorkedAt once: the repeats are 2xx no-ops ({ok:true, deduped:true})', async () => {
        const first = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(await first.json()).toEqual({ ok: true })
        vi.setSystemTime(new Date('2026-08-09T15:00:00.000Z'))
        for (let i = 0; i < 3; i++) {
            const dup = await POST(
                reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
            )
            expect(dup.status).toBe(200)
            expect(await dup.json()).toEqual({ ok: true, deduped: true })
        }

        // One write, carrying the FIRST report's time: the repeats 3h later did
        // not move lastWorkedAt.
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
        expect(txMock.couponSignal.upsert.mock.calls[0]![0].update).toEqual({
            lastWorkedAt: new Date('2026-08-09T12:00:00.000Z'),
        })
    })

    it('honest WORKED reports from distinct IPs each count, and the same IP counts again after 24h', async () => {
        for (const ip of ['198.51.100.1', '198.51.100.2']) {
            await POST(
                reportRequest(
                    KNOWN_COUPON,
                    { outcome: 'worked' },
                    undefined,
                    ip,
                ),
            )
        }
        vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))
        const nextDay = await POST(
            reportRequest(
                KNOWN_COUPON,
                { outcome: 'worked' },
                undefined,
                '198.51.100.1',
            ),
        )

        expect(await nextDay.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(3)
    })

    it('repeat FAILED reports from distinct IPs each count', async () => {
        for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
            await POST(
                reportRequest(
                    KNOWN_COUPON,
                    { outcome: 'failed' },
                    undefined,
                    ip,
                ),
            )
        }

        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(3)
    })

    it('a second FAILED report from the SAME IP for the SAME coupon is a 2xx no-op ({ok:true, deduped:true}): nothing written, no error', async () => {
        const first = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        expect(await first.json()).toEqual({ ok: true })

        for (let i = 0; i < 5; i++) {
            const dup = await POST(
                reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
            )
            expect(dup.status).toBe(200)
            expect(await dup.json()).toEqual({ ok: true, deduped: true })
        }
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
    })

    it('the dedupe is per (IP, coupon): the same IP can still report a DIFFERENT coupon failing', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        const other = await POST(reportRequest('43', { outcome: 'failed' }))

        expect(await other.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('a worked report from an IP that already reported failed is not blocked', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        const worked = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(await worked.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('a WORKED report does not consume the failed slot: worked first, then the first failed report from that IP still counts', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'worked' }))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )

        expect(await failed.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('a deduped signed-in failed report opens no transaction and writes nothing', async () => {
        signedInAs('user-1')
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        prismaMock.$transaction.mockClear()
        txMock.couponSignal.upsert.mockClear()

        const dup = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await dup.json()).toEqual({ ok: true, deduped: true })
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()
    })

    it('signed-in reporters are keyed by USER, not IP: two users behind one IP both count and both keep their attribution row', async () => {
        signedInAs('user-1')
        const first = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        signedInAs('user-2')
        const second = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await first.json()).toEqual({ ok: true })
        expect(await second.json()).toEqual({ ok: true })
        expect(reportRows.map(row => row.userId)).toEqual(['user-1', 'user-2'])
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('the same signed-in user is deduped even from a different IP', async () => {
        signedInAs('user-1')
        await POST(
            reportRequest(
                KNOWN_COUPON,
                { outcome: 'failed' },
                'Bearer good',
                '198.51.100.1',
            ),
        )
        const again = await POST(
            reportRequest(
                KNOWN_COUPON,
                { outcome: 'failed' },
                'Bearer good',
                '198.51.100.2',
            ),
        )

        expect(await again.json()).toEqual({ ok: true, deduped: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
    })

    it('an anonymous report and a signed-in user behind the same IP do not share a slot', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        signedInAs('user-1')
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await res.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(2)
    })

    it('a failed write frees the slot: the retry from the same IP is NOT deduped', async () => {
        txMock.couponSignal.upsert.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        expect(failed.status).toBe(500)

        const retry = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        expect(await retry.json()).toEqual({ ok: true })
    })

    it('a failed WORKED write frees its slot too: the retry is NOT deduped', async () => {
        txMock.couponSignal.upsert.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(failed.status).toBe(500)

        const retry = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(await retry.json()).toEqual({ ok: true })
    })

    it('an id that is well-formed but absent from the catalog → 404, NO signal written, no transaction', async () => {
        catalogIds.clear() // nothing exists in the catalog

        const res = await POST(
            reportRequest('999000404', { outcome: 'worked' }),
        )

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'Unknown coupon' })
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('an unknown id does not consume the dedupe slot: once the coupon exists the same reporter still counts', async () => {
        catalogIds.clear()
        const miss = await POST(
            reportRequest('999000404', { outcome: 'failed' }),
        )
        expect(miss.status).toBe(404)

        catalogIds.add('999000404')
        const hit = await POST(
            reportRequest('999000404', { outcome: 'failed' }),
        )

        expect(hit.status).toBe(200)
        expect(await hit.json()).toEqual({ ok: true })
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
    })

    it('probing unknown ids can never fill the dedupe table: every probe frees its slot', async () => {
        catalogIds.clear()
        resetReportDedupeForTests({ maxKeys: 2 })
        for (let id = 999000400; id < 999000410; id++) {
            const res = await POST(
                reportRequest(String(id), { outcome: 'failed' }),
            )
            expect(res.status).toBe(404)
        }
        // The two-key table is empty, not full of probes: a real report from
        // the same reporter is tracked as a first report, then deduped.
        catalogIds.add(KNOWN_COUPON)
        const first = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        const second = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        expect(await first.json()).toEqual({ ok: true })
        expect(await second.json()).toEqual({ ok: true, deduped: true })
    })

    it('the existence check is one status-agnostic primary-key lookup, bound (never inlined) and run after the dedupe', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'worked' }))

        expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
        const query = prismaMock.$queryRaw.mock.calls[0]![0]
        expect(query.sql).toContain('FROM coupons WHERE id = ?')
        expect(query.values).toEqual([KNOWN_COUPON])
        // Hidden ('invalid') and expired rows are catalog rows too: no status or
        // expired predicate, so a stale cached card's vote is not an error.
        expect(query.sql).not.toMatch(/status|expired/i)

        // A tracked duplicate answers from memory, with no database round trip.
        prismaMock.$queryRaw.mockClear()
        const dup = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(await dup.json()).toEqual({ ok: true, deduped: true })
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })

    it('at a full dedupe table, probing unknown ids evicts at most ONE honest slot, however many probes', async () => {
        resetReportDedupeForTests({ maxKeys: 2 })
        const honest = ['198.51.100.1', '198.51.100.2']
        for (const ip of honest) {
            await POST(
                reportRequest(
                    KNOWN_COUPON,
                    { outcome: 'failed' },
                    undefined,
                    ip,
                ),
            )
        }
        // 20 probes from a third address, each for a fresh unknown id.
        for (let id = 999000400; id < 999000420; id++) {
            const res = await POST(
                reportRequest(
                    String(id),
                    { outcome: 'failed' },
                    undefined,
                    '198.51.100.3',
                ),
            )
            expect(res.status).toBe(404)
        }

        let stillDeduped = 0
        for (const ip of honest) {
            const res = await POST(
                reportRequest(
                    KNOWN_COUPON,
                    { outcome: 'failed' },
                    undefined,
                    ip,
                ),
            )
            if ((await res.json()).deduped === true) stillDeduped++
        }
        expect(stillDeduped).toBeGreaterThanOrEqual(1)
    })

    it('a failing existence lookup is a 500 (loud, to Sentry) and frees the slot for the retry', async () => {
        prismaMock.$queryRaw.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(failed.status).toBe(500)
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()

        const retry = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(await retry.json()).toEqual({ ok: true })
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

    it('a same-day repeat is IDEMPOTENT — 200, no second row, and the aggregate signal is not written again', async () => {
        signedInAs('user-1')

        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        vi.setSystemTime(new Date('2026-08-09T23:59:59.000Z')) // same UTC day
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, deduped: true })
        expect(txMock.couponReport.create).toHaveBeenCalledTimes(1)
        expect(reportRows).toHaveLength(1)
        // Deduped per USER like an anonymous repeat is per IP: one write.
        expect(txMock.couponSignal.upsert).toHaveBeenCalledTimes(1)
    })

    it('after a restart empties the in-memory window, the day-scoped attribution check still stops a second row', async () => {
        signedInAs('user-1')

        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        resetReportDedupeForTests() // a deploy or restart
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        expect(await res.json()).toEqual({ ok: true })
        expect(reportRows).toHaveLength(1)
    })

    it('the SAME user reporting the SAME coupon the next UTC day is attributed again', async () => {
        signedInAs('user-1')

        vi.setSystemTime(new Date('2026-08-09T23:59:00.000Z'))
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        vi.setSystemTime(new Date('2026-08-10T00:01:00.000Z')) // 2 minutes later
        // The in-memory 24h window would dedupe this; empty it (as a restart
        // does) so what is pinned is the attribution's UTC-day window.
        resetReportDedupeForTests()
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

    it('an unknown coupon id → 404 for a signed-in reporter too: no transaction, no signal, no attribution row', async () => {
        signedInAs('user-1')
        catalogIds.clear() // the id is well-formed but no catalog row exists

        const res = await POST(
            reportRequest('999000404', { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'Unknown coupon' })
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(txMock.couponSignal.upsert).not.toHaveBeenCalled()
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
