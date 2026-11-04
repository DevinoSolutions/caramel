import { listStoreCoupons } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// T-10431 — the proof tier of a store's list, run for REAL against a live
// migrated Postgres. The extension tries only the first ~8 codes of page 1, so
// a code the pipeline proved working yesterday must not sit behind higher-rated
// stale ones (shopmicas.com, 2026-10-29: SARA12, proven that day, ranked past
// the 8 the extension tried, and auto-apply failed). Order inside a store:
// proven (green-tier) codes, freshest proof first; then restricted (amber)
// codes; then everything else; rating only breaks ties inside a group.
//
// Private site + id range (988100xxx), removed afterwards.

const SITE = 'proof-tier-10431.example'
const DAY = 24 * 60 * 60 * 1000

type Fixture = { id: string; status: string; rating: number; ageDays: number }

const FIXTURES: Fixture[] = [
    { id: '988100001', status: 'pending', rating: 5, ageDays: 0 },
    { id: '988100002', status: 'valid', rating: 1, ageDays: 1 },
    { id: '988100003', status: 'valid', rating: 5, ageDays: 30 },
    { id: '988100004', status: 'valid_with_warning', rating: 5, ageDays: 0 },
    { id: '988100005', status: 'valid', rating: 3, ageDays: 1 },
]
const IDS = FIXTURES.map(f => f.id)

async function cleanup() {
    await prisma.coupon.deleteMany({ where: { id: { in: IDS } } })
}

beforeAll(async () => {
    await cleanup()
    const now = Date.now()
    for (const f of FIXTURES) {
        await prisma.coupon.create({
            data: {
                id: f.id,
                code: `PROOF${f.id}`,
                site: SITE,
                title: `Proof-tier fixture ${f.id}`,
                description: 'fixture',
                rating: f.rating,
                status: f.status,
                updatedAt: new Date(now - f.ageDays * DAY),
            },
        })
    }
})

afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('store list proof tier (real pg)', () => {
    it('freshly proven codes lead, freshest first, rating breaking the tie; restricted next; unproven last', async () => {
        const { coupons } = await listStoreCoupons(SITE, 20)

        expect(coupons.map(c => c.id)).toEqual([
            '988100005', // valid, proven a day ago, rating 3
            '988100002', // valid, proven a day ago, rating 1
            '988100003', // valid but its proof is 30 days old, despite rating 5
            '988100004', // restricted (amber), however fresh or highly rated
            '988100001', // unverified, despite rating 5 and the newest stamp
        ])
    })
})
