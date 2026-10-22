import { attachSignals, recordWorked } from '@/lib/couponSignals'
import { isRecentlyFailing } from '@/lib/coupons'
import { listCoupons, listStoreCoupons } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// #288 — recently-failing codes SINK in a store's list (listStoreCoupons and the
// store-scoped listCoupons), run for REAL against a live migrated Postgres: the
// hashed `id IN (SELECT … FROM coupon_signals …)` ORDER BY key, the
// timestamp-WITHOUT-time-zone window compared against UTC, and agreement with
// coupons.ts's isRecentlyFailing (the card's hint).
//
// The suite creates its own catalog rows under a private site and id range
// (988000xxx) and removes them (and their signals) afterwards.

const SITE = 'failing-sink-288.example'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

type Fixture = {
    id: string
    rating: number
    signal?: {
        failCount: number
        failWeight: number // the failure quorum (coupon_signals.fail_weight)
        lastFailedAt: number // ms ago
        lastWorkedAt?: number // ms ago
    }
}

// Listed in expected ranking order WITHOUT any sinking (rating DESC).
const FIXTURES: Fixture[] = [
    // Keeps failing: a collapse-level quorum (weight 6), the latest failure an hour ago, never worked.
    {
        id: '988000001',
        rating: 5,
        signal: { failCount: 3, failWeight: 6, lastFailedAt: HOUR },
    },
    { id: '988000002', rating: 4 },
    // Cleared: failures, then a worked QUORUM after them folded fail_weight to 0
    // (a worked stamp alone clears nothing: see couponSignals.recomputeFailWeight).
    {
        id: '988000003',
        rating: 3,
        signal: {
            failCount: 5,
            failWeight: 0,
            lastFailedAt: 2 * DAY,
            lastWorkedAt: DAY,
        },
    },
    // Expired: failures, but the latest is outside the 30-day window.
    {
        id: '988000004',
        rating: 2,
        signal: { failCount: 4, failWeight: 4, lastFailedAt: 40 * DAY },
    },
    // Noise: a single recent failure (below the quorum).
    {
        id: '988000005',
        rating: 1,
        signal: { failCount: 1, failWeight: 1, lastFailedAt: HOUR },
    },
    // Failing: the (single) success pre-dates the latest failure and clears nothing.
    {
        id: '988000006',
        rating: 0.5,
        signal: {
            failCount: 2,
            failWeight: 4,
            lastFailedAt: HOUR,
            lastWorkedAt: 5 * DAY,
        },
    },
]
const IDS = FIXTURES.map(f => f.id)

async function cleanup() {
    await prisma.couponSignalReporter.deleteMany({
        where: { couponId: { in: IDS } },
    })
    await prisma.couponSignal.deleteMany({ where: { couponId: { in: IDS } } })
    await prisma.coupon.deleteMany({ where: { id: { in: IDS } } })
}

beforeAll(async () => {
    await cleanup()
    const now = Date.now()
    for (const f of FIXTURES) {
        await prisma.coupon.create({
            data: {
                id: f.id,
                code: `SINK${f.id}`,
                site: SITE,
                title: `Sink fixture ${f.id}`,
                description: 'fixture',
                rating: f.rating,
                status: 'valid',
            },
        })
        if (f.signal) {
            await prisma.couponSignal.create({
                data: {
                    couponId: f.id,
                    failCount: f.signal.failCount,
                    failWeight: f.signal.failWeight,
                    lastFailedAt: new Date(now - f.signal.lastFailedAt),
                    lastWorkedAt:
                        f.signal.lastWorkedAt === undefined
                            ? null
                            : new Date(now - f.signal.lastWorkedAt),
                },
            })
        }
    }
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('failing codes sink (real pg)', () => {
    it('listStoreCoupons: failing codes go last, the rest keep their ranking order, nothing is hidden', async () => {
        const { coupons, total } = await listStoreCoupons(SITE, 20)

        expect(coupons.map(c => c.id)).toEqual([
            '988000002', // rating 4
            '988000003', // rating 3, reset by a later success
            '988000004', // rating 2, failure outside the window
            '988000005', // rating 1, a single failure
            '988000006', // rating 0.5, failing (2 failures): sunk, not collapsed
            '988000001', // rating 5, keeps failing (3 failures): the very last row
        ])
        expect(total).toBe(6)
    })

    it('listCoupons with a site orders identically and pages consistently', async () => {
        const first = await listCoupons({ baseSite: SITE, limit: 4, skip: 0 })
        const second = await listCoupons({ baseSite: SITE, limit: 4, skip: 4 })

        expect(first.coupons.map(c => c.id)).toEqual([
            '988000002',
            '988000003',
            '988000004',
            '988000005',
        ])
        // The failing codes are on page 2 even though one has the best rating:
        // a post-fetch sort of page 1 could not have put them there. The
        // keeps-failing one (collapsed by the page and the popup) is last.
        expect(second.coupons.map(c => c.id)).toEqual([
            '988000006',
            '988000001',
        ])
        expect(first.total).toBe(6)
        expect(second.total).toBe(6)
    })

    it('the SQL ordering and isRecentlyFailing agree on which codes are failing', async () => {
        const { coupons } = await listStoreCoupons(SITE, 20)
        const decorated = await attachSignals(coupons)

        const failingByTs = decorated
            .filter(c => isRecentlyFailing(c))
            .map(c => c.id)
        const tail = decorated.slice(-failingByTs.length).map(c => c.id)

        // Both lists keep list order, so no sorting is needed to compare them.
        expect(failingByTs).toEqual(['988000006', '988000001'])
        expect(tail).toEqual(failingByTs)
    })

    it('keepsFailing (the field /api/coupons ships) is true only for the collapse-quorum code, and that code is the list tail', async () => {
        const { coupons } = await listStoreCoupons(SITE, 20)
        const decorated = await attachSignals(coupons)

        expect(decorated.filter(c => c.keepsFailing).map(c => c.id)).toEqual([
            '988000001',
        ])
        expect(decorated[decorated.length - 1]?.keepsFailing).toBe(true)
        // Collapsing is presentation only: the row is still listed, still valid.
        expect(coupons.find(c => c.id === '988000001')?.status).toBe('valid')
        expect(decorated).toHaveLength(6)
    })

    it('a worked quorum lifts a failing code back to its ranking position and clears keepsFailing; one anonymous success alone does not', async () => {
        // A real failure row backing the fixture's weight 6, so the writers'
        // recompute has the reporter it would have in production.
        await prisma.couponSignalReporter.create({
            data: {
                couponId: '988000001',
                outcome: 'failed',
                reporterHash: 'sink-fixture',
                weight: 6,
                lastAt: new Date(Date.now() - HOUR),
            },
        })
        await recordWorked('988000001', { kind: 'ip', ip: '203.0.113.50' })
        {
            const { coupons } = await listStoreCoupons(SITE, 20)
            const decorated = await attachSignals(coupons)
            expect(decorated[decorated.length - 1]?.id).toBe('988000001')
            expect(decorated.some(c => c.keepsFailing)).toBe(true)
        }

        await recordWorked('988000001', { kind: 'ip', ip: '203.0.113.51' })
        const { coupons } = await listStoreCoupons(SITE, 20)
        const decorated = await attachSignals(coupons)

        expect(coupons[0]?.id).toBe('988000001')
        expect(decorated.some(c => c.keepsFailing)).toBe(false)
    })
})
