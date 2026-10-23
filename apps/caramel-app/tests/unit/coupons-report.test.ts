import { POST } from '@/app/api/coupons/[id]/report/route'
import { resetReportDedupeForTests } from '@/lib/couponReportDedupe'
import { resetReportVelocityForTests } from '@/lib/couponReportVelocity'
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
// catalog-existence gate (the `$queryRaw` INSERT ... SELECT ... WHERE EXISTS of
// couponsRepo.writeCouponSignal, whose composed `.sql` is asserted below) are
// genuinely EXERCISED. A canned `findFirst: async () => null` would let a
// deleted dedup check pass every assertion here. The real query SHAPE is
// pinned separately (see "the dedup lookup is scoped to…"), because a fake can
// only ever prove the logic, never the SQL.
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
        // to `coupons`, so the aggregate write gates itself on a catalog row; an
        // id absent from this set is the unknown-coupon case (the statement
        // writes and returns no row: 404, nothing written).
        const ids = new Set<string>()

        // The aggregate coupon_signals write is ONE raw statement that is also
        // the existence gate (couponsRepo.writeCouponSignal): its first bound
        // value is the coupon id. A known id returns the row's fail_weight
        // (0 here, so no quorum bookkeeping follows), an unknown id returns no
        // row, exactly as `INSERT ... SELECT ... WHERE EXISTS ... RETURNING`.
        const txSignalWrite = vi.fn(
            async (query: { sql: string; values: unknown[] }) =>
                ids.has(String(query.values[0])) ? [{ failWeight: 0 }] : [],
        )

        const tx = {
            // recordFailed's quorum bookkeeping (couponSignals.ts). This file
            // pins the ROUTE's wiring, so these are canned test doubles; the
            // quorum arithmetic itself is pinned in coupon-failure-quorum.test.ts
            // against an in-memory reporters table, and in the integration suite
            // against real Postgres.
            $queryRaw: txSignalWrite,
            couponSignal: {
                update: vi.fn(async () => ({})),
            },
            couponSignalReporter: {
                findMany: vi.fn(async () => []),
                // A low-trust "worked" counts its distinct reporters (the
                // quorum for the Verified stamp): none reached it here.
                count: vi.fn(async () => 0),
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
        // An account old enough to be ESTABLISHED (accountReputation.ts): its
        // "worked" stamps on its own say-so, a low-trust one does not.
        user: { id: userId, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    }))
}

/** better-auth resolves NOTHING — the anonymous case (no, garbage, or expired
 * credential all land here: getSession returns null, it does not throw). */
function anonymous() {
    getSessionMock.mockImplementation(async () => null)
}

beforeEach(() => {
    resetReportDedupeForTests()
    resetReportVelocityForTests()
    prismaMock.$transaction.mockClear()
    txMock.$queryRaw.mockClear()
    txMock.couponSignalReporter.upsert.mockClear()
    txMock.couponSignalReporter.count.mockClear()
    txMock.couponSignalReporter.deleteMany.mockClear()
    txMock.couponSignal.update.mockClear()
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
    it('outcome "worked" from an ESTABLISHED account → 200 {ok:true}, stamps lastWorkedAt ONLY (no workCount — increment owns that)', async () => {
        signedInAs('user-1')
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
        const query = txMock.$queryRaw.mock.calls[0]![0]
        // The coupon id is bound twice: the inserted key and the EXISTS gate.
        expect(query.values).toEqual([KNOWN_COUPON, KNOWN_COUPON])
        // W4-D2 split: recordWorked owns lastWorkedAt; recordUsage (POST
        // /increment) owns workCount. A "worked" report must NOT bump workCount,
        // or a successful apply (which fires BOTH report+increment) double-counts.
        expect(query.sql).toContain('last_worked_at = EXCLUDED.last_worked_at')
        expect(query.sql).not.toContain('work_count')
        expect(query.sql).not.toContain('fail_count')
    })

    // T-6222 by another door: the report route's "worked" used to stamp
    // last_worked_at for ANY caller, anonymous or forged. A low-trust reporter's
    // report is accepted (same 200, same body) and the existence gate still
    // runs, but the statement carries no stamp.
    it.each([
        ['an anonymous caller', undefined],
        ['a YOUNG account', 'young'],
    ] as const)(
        'outcome "worked" from %s → 200 {ok:true} but the statement does NOT touch last_worked_at',
        async (_who, kind) => {
            if (kind === 'young') {
                getSessionMock.mockImplementation(async () => ({
                    session: { id: 'session-young' },
                    user: { id: 'young-user', createdAt: new Date() },
                }))
            }
            const res = await POST(
                reportRequest(
                    KNOWN_COUPON,
                    { outcome: 'worked' },
                    kind ? 'Bearer good' : undefined,
                ),
            )

            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ ok: true })
            expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
            const query = txMock.$queryRaw.mock.calls[0]![0]
            expect(query.values).toEqual([KNOWN_COUPON, KNOWN_COUPON])
            expect(query.sql).not.toContain('last_worked_at')
            expect(query.sql).not.toContain('work_count')
            // The reporter is remembered (hashed) for the worked quorum.
            expect(txMock.couponSignalReporter.upsert).toHaveBeenCalledTimes(1)
        },
    )

    it('the worked quorum: once enough DISTINCT low-trust reporters are counted, the next report stamps last_worked_at', async () => {
        txMock.couponSignalReporter.count.mockResolvedValueOnce(3)
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(res.status).toBe(200)
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
        expect(txMock.$queryRaw.mock.calls[1]![0].sql).toContain(
            'last_worked_at = EXCLUDED.last_worked_at',
        )
    })

    it('an unknown id from a low-trust "worked" is still a 404 that wrote no reporter row', async () => {
        catalogIds.clear()
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(res.status).toBe(404)
        expect(txMock.couponSignalReporter.upsert).not.toHaveBeenCalled()
    })

    it('outcome "failed" with a storeReason → 200, upserts a fail signal carrying the reason', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, {
                outcome: 'failed',
                storeReason: 'Minimum spend not met',
            }),
        )

        expect(res.status).toBe(200)
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
        const query = txMock.$queryRaw.mock.calls[0]![0]
        // The key, the bound reason, then the EXISTS gate's id.
        expect(query.values).toEqual([
            KNOWN_COUPON,
            'Minimum spend not met',
            KNOWN_COUPON,
        ])
        expect(query.sql).toContain(
            'fail_count = coupon_signals.fail_count + 1',
        )
        expect(query.sql).toContain(
            'last_fail_reason = EXCLUDED.last_fail_reason',
        )
        expect(query.sql).not.toContain('work_count')
    })

    it('a non-numeric id (abc) → 400, nothing written', async () => {
        const res = await POST(reportRequest('abc', { outcome: 'worked' }))

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            error: 'Invalid or missing coupon ID',
        })
        expect(txMock.$queryRaw).not.toHaveBeenCalled()
    })

    it('an invalid outcome → 422 (withRoute body gate), nothing written', async () => {
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'maybe' }),
        )

        expect(res.status).toBe(422)
        expect(txMock.$queryRaw).not.toHaveBeenCalled()
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
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

        // One write: the repeats 3h later issued no statement, so they did not
        // move lastWorkedAt.
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(3)
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

        expect(txMock.$queryRaw).toHaveBeenCalledTimes(3)
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    })

    it('the dedupe is per (IP, coupon): the same IP can still report a DIFFERENT coupon failing', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        const other = await POST(reportRequest('43', { outcome: 'failed' }))

        expect(await other.json()).toEqual({ ok: true })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
    })

    it('a worked report from an IP that already reported failed is not blocked', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        const worked = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )

        expect(await worked.json()).toEqual({ ok: true })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
    })

    it('a WORKED report does not consume the failed slot: worked first, then the first failed report from that IP still counts', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'worked' }))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )

        expect(await failed.json()).toEqual({ ok: true })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
    })

    it('a deduped signed-in failed report opens no transaction and writes nothing', async () => {
        signedInAs('user-1')
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        prismaMock.$transaction.mockClear()
        txMock.$queryRaw.mockClear()

        const dup = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await dup.json()).toEqual({ ok: true, deduped: true })
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(txMock.$queryRaw).not.toHaveBeenCalled()
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    })

    it('an anonymous report and a signed-in user behind the same IP do not share a slot', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        signedInAs('user-1')
        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await res.json()).toEqual({ ok: true })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
    })

    it('a failed write frees the slot: the retry from the same IP is NOT deduped', async () => {
        txMock.$queryRaw.mockRejectedValueOnce(new Error('db down'))
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
        txMock.$queryRaw.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(failed.status).toBe(500)

        const retry = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(await retry.json()).toEqual({ ok: true })
    })

    it('an id that is well-formed but absent from the catalog → 404, and the ONE write statement that detected it left nothing behind (no reporter row, no attribution)', async () => {
        catalogIds.clear() // nothing exists in the catalog

        for (const outcome of ['worked', 'failed'] as const) {
            resetReportDedupeForTests()
            txMock.$queryRaw.mockClear()
            const res = await POST(reportRequest('999000404', { outcome }))

            expect(res.status).toBe(404)
            expect(await res.json()).toEqual({ error: 'Unknown coupon' })
            // One statement: the INSERT ... WHERE EXISTS selected zero rows.
            // There is no separate existence lookup before it.
            expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
            expect(txMock.couponSignalReporter.upsert).not.toHaveBeenCalled()
            expect(
                txMock.couponSignalReporter.deleteMany,
            ).not.toHaveBeenCalled()
            expect(txMock.couponSignal.update).not.toHaveBeenCalled()
        }
    })

    it('an unknown id releases its dedupe slot: the SAME reporter repeating it gets 404 again, never {deduped:true}', async () => {
        catalogIds.clear()

        for (const outcome of ['worked', 'failed'] as const) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const res = await POST(reportRequest('999000404', { outcome }))
                expect(res.status).toBe(404)
                expect(await res.json()).toEqual({ error: 'Unknown coupon' })
            }
        }
    })

    it('a signed-in report for an unknown id → 404, no attribution row, slot released', async () => {
        catalogIds.clear()
        signedInAs('user-1')

        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await POST(
                reportRequest(
                    '999000404',
                    { outcome: 'failed' },
                    'Bearer good',
                ),
            )
            expect(res.status).toBe(404)
            expect(await res.json()).toEqual({ error: 'Unknown coupon' })
        }
        expect(txMock.couponReport.findFirst).not.toHaveBeenCalled()
        expect(txMock.couponReport.create).not.toHaveBeenCalled()
        expect(reportRows).toEqual([])
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
        // One statement per attempt: the miss, then the write that landed.
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2)
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

    it('a known id costs ONE signal statement: the existence check is folded into the write as a status-agnostic primary-key EXISTS, bound (never inlined), run after the dedupe', async () => {
        signedInAs('user-1')
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )

        // No lookup + write pair: exactly one statement, no reporter rows (the
        // coupon carries no failure quorum), no second write.
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
        expect(txMock.couponSignalReporter.upsert).not.toHaveBeenCalled()
        const query = txMock.$queryRaw.mock.calls[0]![0]
        expect(query.sql).toMatch(
            /INSERT INTO coupon_signals[\s\S]*SELECT[\s\S]*WHERE EXISTS \(SELECT 1 FROM coupons WHERE id = \?::text\)[\s\S]*ON CONFLICT \(coupon_id\) DO UPDATE SET/,
        )
        expect(query.sql).toContain('RETURNING fail_weight')
        expect(query.values).toEqual([KNOWN_COUPON, KNOWN_COUPON])
        // Hidden ('invalid') and expired rows are catalog rows too: no status or
        // expired predicate, so a stale cached card's vote is not an error.
        expect(query.sql).not.toMatch(/status|expired/i)

        // A tracked duplicate answers from memory, with no database round trip.
        txMock.$queryRaw.mockClear()
        prismaMock.$transaction.mockClear()
        const dup = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }, 'Bearer good'),
        )
        expect(await dup.json()).toEqual({ ok: true, deduped: true })
        expect(txMock.$queryRaw).not.toHaveBeenCalled()
        expect(prismaMock.$transaction).not.toHaveBeenCalled()
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

    it('a failing signal write is a 500 (loud, to Sentry) and frees the slot for the retry', async () => {
        txMock.$queryRaw.mockRejectedValueOnce(new Error('db down'))
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'worked' }),
        )
        expect(failed.status).toBe(500)
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)

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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
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
        expect(txMock.$queryRaw.mock.calls[0]![0].values).toEqual([
            KNOWN_COUPON,
            'Expired code',
            KNOWN_COUPON,
        ])
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
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
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

    it('an unknown coupon id → 404 for a signed-in reporter too: one statement that wrote nothing, no attribution row', async () => {
        signedInAs('user-1')
        catalogIds.clear() // the id is well-formed but no catalog row exists

        const res = await POST(
            reportRequest('999000404', { outcome: 'worked' }, 'Bearer good'),
        )

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'Unknown coupon' })
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
        expect(txMock.couponReport.findFirst).not.toHaveBeenCalled()
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

// T-6227: a per-COUPON velocity cap across ALL reporters, and the reporter's
// weight following the account's age. The cap's own arithmetic (window, bounded
// table, Sentry) is pinned in coupon-report-velocity.test.ts; here only the
// route's wiring of it.
describe('POST /api/coupons/[id]/report — per-coupon velocity cap and account reputation (T-6227)', () => {
    // COUPON_REPORT_MAX_LOW_TRUST_PER_COUPON_PER_HOUR default: the anonymous
    // callers below are low-trust, and have the smaller bucket.
    const MAX = 5
    const ip = (n: number) => `203.0.113.${n}`
    const anonReport = (id: string, outcome: 'failed' | 'worked', n: number) =>
        reportRequest(id, { outcome }, undefined, ip(n))

    it.each(['failed', 'worked'] as const)(
        'the %s report past the hourly cap is accepted but NOT counted, and answers exactly what a deduped repeat answers',
        async outcome => {
            for (let n = 1; n <= MAX; n++) {
                const res = await POST(anonReport(KNOWN_COUPON, outcome, n))
                expect(await res.json()).toEqual({ ok: true })
            }
            expect(txMock.$queryRaw).toHaveBeenCalledTimes(MAX)

            const over = await POST(anonReport(KNOWN_COUPON, outcome, 200))

            expect(over.status).toBe(200)
            expect(await over.json()).toEqual({ ok: true, deduped: true })
            expect(txMock.$queryRaw).toHaveBeenCalledTimes(MAX)
        },
    )

    it('the cap is per coupon and per kind: a spent failed cap blocks neither worked reports nor another coupon', async () => {
        for (let n = 1; n <= MAX; n++) {
            await POST(anonReport(KNOWN_COUPON, 'failed', n))
        }
        const worked = await POST(anonReport(KNOWN_COUPON, 'worked', 100))
        const other = await POST(anonReport('43', 'failed', 101))

        expect(await worked.json()).toEqual({ ok: true })
        expect(await other.json()).toEqual({ ok: true })
    })

    it('a swarm of low-trust reporters cannot starve an ESTABLISHED account: the buckets are separate', async () => {
        for (let n = 1; n <= MAX + 3; n++) {
            await POST(anonReport(KNOWN_COUPON, 'failed', n))
        }
        signedInAs('old-user')

        const res = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )

        expect(await res.json()).toEqual({ ok: true })
    })

    it('an over-cap report gives the reporter its dedupe slot back: when the window rolls, the same IP counts', async () => {
        for (let n = 1; n <= MAX; n++) {
            await POST(anonReport(KNOWN_COUPON, 'failed', n))
        }
        await POST(anonReport(KNOWN_COUPON, 'failed', 150))
        vi.setSystemTime(new Date('2026-08-09T13:30:00.000Z'))

        const later = await POST(anonReport(KNOWN_COUPON, 'failed', 150))

        expect(await later.json()).toEqual({ ok: true })
    })

    it('probing unknown ids spends no velocity: every probe is a 404, never a silent cap', async () => {
        catalogIds.clear()
        for (let n = 1; n <= MAX + 5; n++) {
            const res = await POST(anonReport(KNOWN_COUPON, 'failed', n))
            expect(res.status).toBe(404)
        }
    })

    it('a failed write gives the velocity slot back as well', async () => {
        txMock.$queryRaw.mockRejectedValueOnce(new Error('db down'))
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const failed = await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }),
        )
        expect(failed.status).toBe(500)
        errorSpy.mockRestore()

        for (let n = 1; n <= MAX; n++) {
            const res = await POST(anonReport(KNOWN_COUPON, 'failed', n))
            expect(await res.json()).toEqual({ ok: true })
        }
    })

    function reporterWeightWritten(): number {
        const calls = txMock.couponSignalReporter.upsert.mock
            .calls as unknown as [{ create: { weight: number } }][]
        return calls[calls.length - 1]![0].create.weight
    }

    function signedInWithAge(userId: string, createdAt: Date | undefined) {
        getSessionMock.mockImplementation(async () => ({
            session: { id: `session-${userId}` },
            user: { id: userId, createdAt },
        }))
    }

    it('an ESTABLISHED account (older than the age gate) reports a failure at the account weight', async () => {
        signedInWithAge('old-user', new Date('2026-07-01T00:00:00.000Z'))
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        expect(reporterWeightWritten()).toBe(2)
    })

    it('a YOUNG account reports a failure at the anonymous-network weight', async () => {
        signedInWithAge('new-user', new Date('2026-08-09T11:00:00.000Z'))
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        expect(reporterWeightWritten()).toBe(1)
    })

    it('an account whose age cannot be read gets no trust (weight of a network)', async () => {
        signedInWithAge('unknown-age', undefined)
        await POST(
            reportRequest(KNOWN_COUPON, { outcome: 'failed' }, 'Bearer good'),
        )
        expect(reporterWeightWritten()).toBe(1)
    })

    it('an anonymous failure is the anonymous-network weight', async () => {
        await POST(reportRequest(KNOWN_COUPON, { outcome: 'failed' }))
        expect(reporterWeightWritten()).toBe(1)
    })
})
