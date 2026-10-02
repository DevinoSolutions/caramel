import { IngestCatalogPayloadSchema } from '@/lib/catalog/ingestSchemas'
import { listStoreCoupons, submitShopperCoupon } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import {
    SHOPPER_COUPON_DESCRIPTION,
    SHOPPER_COUPON_ID_FLOOR,
    SHOPPER_DAILY_SUBMISSION_CAP,
    ShopperSubmissionLimitError,
} from '@/lib/shopperCoupons'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// Shopper-submitted codes against the REAL prisma client + the LOCAL compose
// Postgres (:58005) with migrations applied, including
// 20261002120000_shopper_coupon_submissions (the reserved id sequence + the
// attribution columns). NEVER point this at a remote DATABASE_URL: it writes.
//
// Every row lives on a private store (shopper-itest.example) and is attributed
// to one of this suite's own users, so cleanup is "delete the coupons those
// users submitted, then the users" and cannot touch another suite's data
// (the other itests use their own sites and id ranges).
const BASE = 'shopper-itest.example'
const USER_IDS = ['shopper-itest-user-a', 'shopper-itest-user-b'] as const
const [USER_A, USER_B] = USER_IDS

async function cleanup() {
    await prisma.coupon.deleteMany({
        where: { site: { in: [BASE, `www.${BASE}`] } },
    })
    await prisma.coupon.deleteMany({
        where: { submittedByUserId: { in: [...USER_IDS] } },
    })
    await prisma.user.deleteMany({ where: { id: { in: [...USER_IDS] } } })
}

beforeEach(async () => {
    await cleanup()
    for (const id of USER_IDS) {
        await prisma.user.create({
            data: { id, email: `${id}@shopper-itest.example` },
        })
    }
})
afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('submitShopperCoupon (real pg :58005)', () => {
    it('creates a pending row with an id from the reserved range, attributed to the shopper, shown on the store page with a derived title', async () => {
        const result = await submitShopperCoupon({
            base: BASE,
            code: 'ShopperCode1',
            source: 'manual',
            userId: USER_A,
        })

        expect(result.created).toBe(true)
        expect(BigInt(result.couponId)).toBeGreaterThanOrEqual(
            SHOPPER_COUPON_ID_FLOOR,
        )

        const row = await prisma.coupon.findUniqueOrThrow({
            where: { id: result.couponId },
        })
        expect(row).toMatchObject({
            code: 'ShopperCode1',
            site: BASE,
            title: '',
            description: SHOPPER_COUPON_DESCRIPTION,
            status: 'pending',
            expired: false,
            submittedByUserId: USER_A,
            submissionSource: 'manual',
        })
        // UTC wall-clock stamps: "just now", not shifted by the session zone.
        expect(Date.now() - row.createdAt.getTime()).toBeLessThan(60_000)
        expect(
            Math.abs(row.createdAt.getTime() - row.updatedAt.getTime()),
        ).toBe(0)

        const { coupons } = await listStoreCoupons(BASE, 10)
        const listed = coupons.find(c => c.id === result.couponId)
        expect(listed).toBeDefined()
        expect(listed?.code).toBe('ShopperCode1')
        expect(listed?.status).toBe('pending')
        // title '' is replaced at read time (couponTitleText.ts).
        expect(listed?.title).toBe(`${BASE} promo code ShopperCode1`)
    })

    it('records a checkout capture with submission_source=checkout', async () => {
        const { couponId } = await submitShopperCoupon({
            base: BASE,
            code: 'CHK-1',
            source: 'checkout',
            userId: USER_A,
        })
        const row = await prisma.coupon.findUniqueOrThrow({
            where: { id: couponId },
        })
        expect(row.submissionSource).toBe('checkout')
    })

    it('the same code in a different case on the same base is a duplicate: created=false, same id, one row', async () => {
        const first = await submitShopperCoupon({
            base: BASE,
            code: 'DupeCode',
            source: 'manual',
            userId: USER_A,
        })
        const second = await submitShopperCoupon({
            base: BASE.toUpperCase(),
            code: 'dupecode',
            source: 'checkout',
            userId: USER_B,
        })

        expect(second).toEqual({ couponId: first.couponId, created: false })
        expect(await prisma.coupon.count({ where: { site: BASE } })).toBe(1)
    })

    it('treats a subdomain row as the same store (the store page predicate)', async () => {
        await prisma.coupon.create({
            data: {
                id: '700080001',
                code: 'SUBDOMAIN1',
                site: `www.${BASE}`,
                title: 'supplier row',
                description: 'supplier row',
                status: 'valid',
            },
        })
        try {
            const result = await submitShopperCoupon({
                base: BASE,
                code: 'subdomain1',
                source: 'manual',
                userId: USER_A,
            })
            expect(result).toEqual({ couponId: '700080001', created: false })
        } finally {
            await prisma.coupon.delete({ where: { id: '700080001' } })
        }
    })

    it('a code the store page would NOT show (status invalid, expired=false) is not "already listed": a fresh, visible shopper row is created', async () => {
        await prisma.coupon.create({
            data: {
                id: '700080002',
                code: 'DeadCode1',
                site: BASE,
                title: 'dead supplier row',
                description: 'dead supplier row',
                status: 'invalid',
                expired: false,
            },
        })

        const result = await submitShopperCoupon({
            base: BASE,
            code: 'deadcode1',
            source: 'manual',
            userId: USER_A,
        })

        expect(result.created).toBe(true)
        expect(result.couponId).not.toBe('700080002')
        expect(BigInt(result.couponId)).toBeGreaterThanOrEqual(
            SHOPPER_COUPON_ID_FLOOR,
        )
        const { coupons } = await listStoreCoupons(BASE, 10)
        expect(coupons.map(c => c.id)).toEqual([result.couponId])
    })

    it('an EXPIRED copy of the code does not block a fresh submission', async () => {
        const { couponId: expiredId } = await submitShopperCoupon({
            base: BASE,
            code: 'OldCode',
            source: 'manual',
            userId: USER_A,
        })
        await prisma.coupon.update({
            where: { id: expiredId },
            data: { expired: true },
        })

        const again = await submitShopperCoupon({
            base: BASE,
            code: 'OldCode',
            source: 'manual',
            userId: USER_B,
        })
        expect(again.created).toBe(true)
        expect(again.couponId).not.toBe(expiredId)
    })

    it('concurrent submits of one code produce exactly one row (advisory lock)', async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                submitShopperCoupon({
                    base: BASE,
                    code: 'RaceCode',
                    source: 'manual',
                    userId: USER_A,
                }),
            ),
        )

        expect(results.filter(r => r.created)).toHaveLength(1)
        expect(new Set(results.map(r => r.couponId)).size).toBe(1)
        expect(await prisma.coupon.count({ where: { site: BASE } })).toBe(1)
    })

    it('the 21st new code inside 24 hours throws ShopperSubmissionLimitError; a duplicate is still free', async () => {
        for (let i = 0; i < SHOPPER_DAILY_SUBMISSION_CAP; i += 1) {
            const { created } = await submitShopperCoupon({
                base: BASE,
                code: `CAP-${i}`,
                source: 'manual',
                userId: USER_A,
            })
            expect(created).toBe(true)
        }

        await expect(
            submitShopperCoupon({
                base: BASE,
                code: 'CAP-OVER',
                source: 'manual',
                userId: USER_A,
            }),
        ).rejects.toBeInstanceOf(ShopperSubmissionLimitError)
        expect(await prisma.coupon.count({ where: { site: BASE } })).toBe(
            SHOPPER_DAILY_SUBMISSION_CAP,
        )

        // Re-submitting a listed code writes nothing, so it is not limited.
        const duplicate = await submitShopperCoupon({
            base: BASE,
            code: 'cap-0',
            source: 'manual',
            userId: USER_A,
        })
        expect(duplicate.created).toBe(false)

        // The cap is per shopper.
        const other = await submitShopperCoupon({
            base: BASE,
            code: 'CAP-OVER',
            source: 'manual',
            userId: USER_B,
        })
        expect(other.created).toBe(true)
    })

    it('25 concurrent submits of DIFFERENT codes by one shopper create exactly 20 and limit 5 (per-user lock)', async () => {
        const outcomes = await Promise.allSettled(
            Array.from({ length: 25 }, (_, i) =>
                submitShopperCoupon({
                    base: BASE,
                    code: `PAR-${i}`,
                    source: 'manual',
                    userId: USER_A,
                }),
            ),
        )

        const created = outcomes.filter(
            o => o.status === 'fulfilled' && o.value.created,
        )
        const limited = outcomes.filter(
            o =>
                o.status === 'rejected' &&
                o.reason instanceof ShopperSubmissionLimitError,
        )
        // Any OTHER rejection (a deadlock, a timeout) must fail loudly here.
        const unexpected = outcomes.filter(
            o =>
                o.status === 'rejected' &&
                !(o.reason instanceof ShopperSubmissionLimitError),
        )
        expect(unexpected).toEqual([])
        expect(created).toHaveLength(SHOPPER_DAILY_SUBMISSION_CAP)
        expect(limited).toHaveLength(25 - SHOPPER_DAILY_SUBMISSION_CAP)
        expect(
            await prisma.coupon.count({
                where: { submittedByUserId: USER_A },
            }),
        ).toBe(SHOPPER_DAILY_SUBMISSION_CAP)
    })

    it('rows older than 24 hours no longer count toward the cap', async () => {
        for (let i = 0; i < SHOPPER_DAILY_SUBMISSION_CAP; i += 1) {
            await submitShopperCoupon({
                base: BASE,
                code: `AGED-${i}`,
                source: 'manual',
                userId: USER_A,
            })
        }
        await prisma.coupon.updateMany({
            where: { submittedByUserId: USER_A },
            data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        })

        const fresh = await submitShopperCoupon({
            base: BASE,
            code: 'AGED-NEW',
            source: 'manual',
            userId: USER_A,
        })
        expect(fresh.created).toBe(true)
    })

    it('deleting the shopper keeps the code and drops only the attribution (FK SET NULL)', async () => {
        const { couponId } = await submitShopperCoupon({
            base: BASE,
            code: 'KeepMe1',
            source: 'manual',
            userId: USER_A,
        })

        await prisma.user.delete({ where: { id: USER_A } })

        const row = await prisma.coupon.findUniqueOrThrow({
            where: { id: couponId },
        })
        expect(row.submittedByUserId).toBeNull()
        expect(row.code).toBe('KeepMe1')
    })
})

describe('ingest refuses the reserved shopper id range', () => {
    const SUPPLIER_ROW = {
        code: 'SUPPLIER1',
        site: BASE,
        title: 'supplier row',
        description: 'supplier row',
        discount_type: null,
        discount_amount: null,
        expiry: null,
        verification_message: null,
        status: 'valid',
        updated_at: '2026-10-02T00:00:00.000Z',
    }

    it('a supplier row whose id is in the range fails the ingest schema, so applyCatalogRows is never reached', async () => {
        const { couponId } = await submitShopperCoupon({
            base: BASE,
            code: 'Protected1',
            source: 'manual',
            userId: USER_A,
        })

        // The exact collision the guard exists for: a supplier push carrying
        // a shopper row's own id.
        const clash = IngestCatalogPayloadSchema.safeParse({
            coupons: [{ ...SUPPLIER_ROW, id: couponId }],
        })
        expect(clash.success).toBe(false)
        expect(JSON.stringify(clash.error?.issues)).toContain(
            'reserved shopper range',
        )

        const justBelow = IngestCatalogPayloadSchema.safeParse({
            coupons: [{ ...SUPPLIER_ROW, id: '899999999999999999' }],
        })
        expect(justBelow.success).toBe(true)

        const row = await prisma.coupon.findUniqueOrThrow({
            where: { id: couponId },
        })
        expect(row.code).toBe('Protected1')
    })
})
