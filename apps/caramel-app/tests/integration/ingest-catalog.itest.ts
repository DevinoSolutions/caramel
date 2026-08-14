import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import prisma from '@/lib/prisma'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

// W3b integration — applyCatalogRows exercised against the REAL prisma client +
// live local Postgres (:58005), catalog tables migrated (the harness/CI runs
// `prisma migrate deploy` first, which also applies the synthetic seed). Covers
// the three behaviours the route unit test can't reach: only-if-newer, the >20%
// tombstone force-gate, and transaction rollback on a mid-array failure. Test
// rows use a private 8000xxxxx id range so they never collide with the seed
// (900000xxx) or the W1 signal test (999000xxx); all are deleted after each test.

type IngestCoupon = IngestCatalogPayload['coupons'][number]

const VISIBLE_STATUS = [...VISIBLE_COUPON_STATUSES][0]!

function coupon(
    id: string,
    updatedAt: string,
    over: Partial<IngestCoupon> = {},
): IngestCoupon {
    return {
        id,
        code: `CODE-${id}`,
        site: 'ebay.com',
        title: `t-${id}`,
        description: 'd',
        rating: 0,
        discount_type: null,
        discount_amount: null,
        expiry: null,
        expired: false,
        times_used: 0,
        last_time_used: null,
        status: VISIBLE_STATUS,
        verification_message: null,
        updated_at: new Date(updatedAt),
        ...over,
    }
}

function push(coupons: IngestCoupon[], force = false): IngestCatalogPayload {
    return { coupons, storeConfigs: [], sources: [], force }
}

async function countVisible() {
    return prisma.coupon.count({
        where: { expired: false, status: { in: [...VISIBLE_COUPON_STATUSES] } },
    })
}

async function cleanup() {
    await prisma.coupon.deleteMany({ where: { id: { startsWith: '8000' } } })
}

afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('applyCatalogRows — only-if-newer (real pg :58005)', () => {
    it('ignores an older-updated_at re-push and applies a newer one', async () => {
        const id = '800000001'

        const r1 = await applyCatalogRows(
            push([coupon(id, '2026-07-14T12:00:00.000Z', { title: 't-v2' })]),
        )
        expect(r1.gated).toBe(false)
        if (r1.gated) return
        expect(r1.coupons.inserted).toBe(1)

        // Same id, OLDER timestamp → skipped, stored row unchanged.
        const r2 = await applyCatalogRows(
            push([coupon(id, '2026-07-14T06:00:00.000Z', { title: 't-OLD' })]),
        )
        expect(r2.gated).toBe(false)
        if (r2.gated) return
        expect(r2.coupons.skippedOlder).toBe(1)
        expect(r2.coupons.updated).toBe(0)
        expect((await prisma.coupon.findUnique({ where: { id } }))?.title).toBe(
            't-v2',
        )

        // Same id, NEWER timestamp → applied.
        const r3 = await applyCatalogRows(
            push([coupon(id, '2026-07-14T18:00:00.000Z', { title: 't-v3' })]),
        )
        expect(r3.gated).toBe(false)
        if (r3.gated) return
        expect(r3.coupons.updated).toBe(1)
        expect((await prisma.coupon.findUnique({ where: { id } }))?.title).toBe(
            't-v3',
        )
    })
})

describe('applyCatalogRows — a partial store_config never deletes a selector', () => {
    // The producer's served rows are SPARSE (measured 2026-08-14 over 2,132 stores:
    // dismiss_button_xpath null on 97.8%, show_input_xpath on 74.6%), and the schema
    // explicitly allows "a producer may push a partial config (only the fields it
    // re-derived)". The upsert used to write every column verbatim, so those absent
    // fields DELETED what this table was serving — 8 domains lost a field that day,
    // and nothing else writes this table, so the value never came back.
    const store = 'itest-null-preserve.example'

    it('leaves a column alone when the push omits it, and clears it only on an explicit empty string', async () => {
        // Full config first.
        const r1 = await applyCatalogRows({
            coupons: [],
            sources: [],
            force: false,
            storeConfigs: [
                {
                    store_name: store,
                    coupon_input_xpath: 'input#code',
                    apply_button_xpath: 'button#apply',
                    show_input_xpath: 'a#reveal',
                    price_container_xpath: '.total',
                    updated_at: new Date('2026-07-14T12:00:00.000Z'),
                },
            ],
        })
        expect(r1.gated).toBe(false)

        // A later, PARTIAL push: it re-derived the two required selectors and has no
        // opinion on the rest. The omitted columns must survive.
        const r2 = await applyCatalogRows({
            coupons: [],
            sources: [],
            force: false,
            storeConfigs: [
                {
                    store_name: store,
                    coupon_input_xpath: 'input#code-v2',
                    apply_button_xpath: 'button#apply',
                    updated_at: new Date('2026-07-14T18:00:00.000Z'),
                },
            ],
        })
        expect(r2.gated).toBe(false)

        const kept = await prisma.storeConfig.findUnique({
            where: { storeName: store },
        })
        expect(kept?.couponInputXpath).toBe('input#code-v2') // re-derived → applied
        expect(kept?.showInputXpath).toBe('a#reveal') // omitted → PRESERVED
        expect(kept?.priceContainerXpath).toBe('.total') // omitted → PRESERVED

        // Deleting is still possible, but it has to be SAID: '' is the tombstone.
        const r3 = await applyCatalogRows({
            coupons: [],
            sources: [],
            force: false,
            storeConfigs: [
                {
                    store_name: store,
                    coupon_input_xpath: 'input#code-v2',
                    apply_button_xpath: 'button#apply',
                    show_input_xpath: '',
                    updated_at: new Date('2026-07-15T00:00:00.000Z'),
                },
            ],
        })
        expect(r3.gated).toBe(false)

        const cleared = await prisma.storeConfig.findUnique({
            where: { storeName: store },
        })
        expect(cleared?.showInputXpath).toBeNull() // explicit '' → cleared
        expect(cleared?.priceContainerXpath).toBe('.total') // still untouched
    })

    afterEach(async () => {
        await prisma.storeConfig.deleteMany({
            where: { storeName: { startsWith: 'itest-' } },
        })
    })
})

describe('applyCatalogRows — >20% tombstone force-gate', () => {
    it('refuses a >20% tombstoning push without force, applies it with force', async () => {
        // M = before + 3 visible test coupons guarantees expiring all of them
        // exceeds 20% of the whole visible catalog (seed + these) regardless of
        // the seed size: M > 0.2 * (before + M) ⟺ 0.8M > 0.2·before, and
        // M = before + 3 > 0.25·before always holds.
        const before = await countVisible()
        const m = before + 3
        const ids = Array.from(
            { length: m },
            (_, i) => `800010${String(i).padStart(3, '0')}`,
        )

        const seeded = await applyCatalogRows(
            push(ids.map(id => coupon(id, '2026-07-14T12:00:00.000Z'))),
        )
        expect(seeded.gated).toBe(false)
        if (seeded.gated) return
        expect(seeded.coupons.inserted).toBe(m)

        const tombstone = ids.map(id =>
            coupon(id, '2026-07-14T18:00:00.000Z', {
                expired: true,
                status: 'expired',
            }),
        )

        // Without force → gated, nothing applied (all still visible).
        const gated = await applyCatalogRows(push(tombstone, false))
        expect(gated.gated).toBe(true)
        if (!gated.gated) return
        expect(gated.gate.wouldTombstone).toBe(m)
        expect(
            await prisma.coupon.count({
                where: { id: { in: ids }, expired: false },
            }),
        ).toBe(m)

        // With force → applied.
        const forced = await applyCatalogRows(push(tombstone, true))
        expect(forced.gated).toBe(false)
        if (forced.gated) return
        expect(forced.coupons.tombstoned).toBe(m)
        expect(
            await prisma.coupon.count({
                where: { id: { in: ids }, expired: true },
            }),
        ).toBe(m)
    })
})

describe('applyCatalogRows — transaction atomicity', () => {
    it('rolls back the whole push when a row fails mid-array (int4 overflow)', async () => {
        const goodId = '800000101'
        const badId = '800000102'
        const payload = push([
            coupon(goodId, '2026-07-14T12:00:00.000Z'),
            // times_used overflows int4 (max 2147483647): passes zod (a valid JS
            // non-negative int) but fails the INSERT inside the transaction.
            coupon(badId, '2026-07-14T12:00:00.000Z', {
                times_used: 3_000_000_000,
            }),
        ])

        await expect(applyCatalogRows(payload)).rejects.toThrow()
        // The good row must NOT have persisted — the transaction rolled back.
        expect(
            await prisma.coupon.findUnique({ where: { id: goodId } }),
        ).toBeNull()
    })
})
