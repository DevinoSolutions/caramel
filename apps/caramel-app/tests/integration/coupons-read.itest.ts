import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import {
    getCouponStats,
    listActiveSources,
    listCoupons,
    listStoreSitemapEntries,
    listSupportedStoreConfigs,
} from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, describe, expect, it } from 'vitest'

// W4 integration — the flipped coupon READS exercised against the REAL prisma
// client + live local Postgres (:58005), catalog tables migrated + seeded (the
// harness/CI runs `prisma migrate deploy` first, which applies the synthetic
// catalog seed: 30 coupons in the 900000xxx id range across ebay/amazon/
// codecademy/walmart/target, 3 store_configs, 3 sources). This is the real
// proof the verbatim `$queryRaw` SQL actually runs and its rows parse back
// through couponsDb.ts's zod schemas (the `::int` casts return JS numbers, not
// the BigInt that z.number() would reject) — something the mocked unit tests
// can't reach.
//
// Robustness: this suite is READ-ONLY and asserts against the deterministic
// seed. Where a seeded value can be perturbed by a concurrently-running
// integration file, the assertion is scoped so it can't flake:
//   * ingest-catalog.itest.ts transiently inserts coupons on site 'ebay.com'
//     with ids in the 8000xxxxx range (times_used 0), deleted after each test.
//   * So coupon-level assertions filter to the seed's 9000000xx ids, and
//     source aggregates are asserted exactly only for the codecademy source
//     (which no other suite touches) and as lower bounds for the ebay/amazon
//     source. store_configs and the ACTIVE source set are never written by any
//     suite, so those are asserted exactly.

const VISIBLE = new Set<string>(VISIBLE_COUPON_STATUSES)

// The 25 seeded coupons that are VISIBLE (expired=false AND a visible status)
// and the 5 that are not — hand-derived from the seed migration.
const SEEDED_VISIBLE_IDS = [
    '900000001',
    '900000002',
    '900000003',
    '900000004',
    '900000006',
    '900000007',
    '900000009',
    '900000010',
    '900000011',
    '900000012',
    '900000013',
    '900000014',
    '900000016',
    '900000017',
    '900000018',
    '900000019',
    '900000020',
    '900000021',
    '900000023',
    '900000024',
    '900000025',
    '900000027',
    '900000028',
    '900000029',
    '900000030',
]
const SEEDED_NON_VISIBLE_IDS = [
    '900000005', // expired (status expired)
    '900000008', // invalid
    '900000015', // expired
    '900000022', // invalid
    '900000026', // expired
]

afterAll(async () => {
    await prisma.$disconnect()
})

describe('listCoupons — visible seed, ranking, exact row shape (real pg :58005)', () => {
    it('returns every visible seeded coupon (and no non-visible one) in rating-DESC order with the coerced row shape', async () => {
        // Large limit so a concurrent ebay insert can never push a seeded row
        // off the page; then filter to the seed's own id range.
        const { coupons } = await listCoupons({ limit: 500, skip: 0 })
        const seeded = coupons.filter(c => c.id.startsWith('9000000'))
        const seededIds = seeded.map(c => c.id)

        for (const id of SEEDED_VISIBLE_IDS) {
            expect(seededIds).toContain(id)
        }
        for (const id of SEEDED_NON_VISIBLE_IDS) {
            expect(seededIds).not.toContain(id)
        }

        // Every returned row carries a visible status and is not expired — the
        // predicate held for real.
        for (const c of seeded) {
            expect(VISIBLE.has(c.status)).toBe(true)
            expect(c.expired).toBe(false)
        }

        // ORDER BY rating DESC (primary key of the ranking) — the seeded
        // subset preserves the DB's relative order after filtering.
        for (let i = 1; i < seeded.length; i++) {
            expect(seeded[i - 1]!.rating).toBeGreaterThanOrEqual(
                seeded[i]!.rating,
            )
        }

        // Exact coerced shape of a known row (LEARN40): TEXT id stays a
        // string, DOUBLE PRECISION rating/discount_amount are numbers,
        // INTEGER times_used is a number, discount_type upper-normalized.
        const learn40 = seeded.find(c => c.id === '900000017')
        expect(learn40).toEqual({
            id: '900000017',
            code: 'LEARN40',
            site: 'codecademy.com',
            title: '40% off Pro annual',
            description: 'Save 40% on a Codecademy Pro annual plan.',
            rating: 4.9,
            discount_type: 'PERCENTAGE',
            discount_amount: 40,
            expiry: '2026-12-31',
            expired: false,
            timesUsed: 415,
            status: 'valid',
            verificationMessage: 'Verified working on 2026-07-13',
        })
    })
})

describe('getCouponStats — verified census (real pg :58005)', () => {
    it("counts status='valid' coupons as plain numbers (the ::int cast, not BigInt) with the 7 seeded valid rows present", async () => {
        const stats = await getCouponStats()
        // ::int-cast aggregates come back as JS numbers; a dropped cast would
        // return BigInt and StatsRowSchema's z.number() would have thrown.
        expect(typeof stats.total).toBe('number')
        expect(typeof stats.expired).toBe('number')
        // 7 seeded coupons have status='valid' (001/009/010/016/017/023/027),
        // all non-expired. A concurrent suite may add more 'valid' rows, never
        // fewer, and never a valid+expired one — so total >= 7 and expired 0.
        expect(stats.total).toBeGreaterThanOrEqual(7)
        expect(stats.expired).toBe(0)
    })
})

describe('listSupportedStoreConfigs — flattened store_configs (real pg :58005)', () => {
    it('returns the 3 seeded stores in store_name order, with nullable xpaths preserved', async () => {
        const configs = await listSupportedStoreConfigs()
        expect(configs.map(c => c.store_name)).toEqual([
            'amazon.com',
            'codecademy.com',
            'ebay.com',
        ])

        // codecademy.com deliberately seeds two NULL xpaths (dismiss + remove)
        // to exercise the nullable columns end-to-end.
        const codecademy = configs.find(c => c.store_name === 'codecademy.com')
        expect(codecademy).toEqual({
            store_name: 'codecademy.com',
            show_input_xpath: '//button[@data-testid="add-coupon"]',
            dismiss_button_xpath: null,
            coupon_input_xpath: '//input[@name="couponCode"]',
            apply_button_xpath: '//button[@data-testid="apply-coupon"]',
            price_container_xpath: '//div[@data-testid="summary-total"]',
            success_indicator_xpath: '//div[@data-testid="coupon-success"]',
            error_indicator_xpath: '//div[@data-testid="coupon-error"]',
            coupon_remove_xpath: null,
        })
    })
})

describe('listActiveSources — sources ⋈ coupons aggregates (real pg :58005)', () => {
    it('returns only ACTIVE sources with their JOIN aggregates as numbers', async () => {
        const sources = await listActiveSources()
        const byId = new Map(sources.map(s => [s.id, s]))

        // Exactly the 2 ACTIVE seeded sources — the REQUESTED one is excluded.
        expect(sources.map(s => s.id).sort()).toEqual([
            'seed-source-001',
            'seed-source-002',
        ])
        expect(byId.has('seed-source-003')).toBe(false)

        // codecademy source is untouched by any other suite → exact aggregates.
        // 6 coupons (900000017-022), SUM(times_used)=415+128+22+40+9+3=617,
        // none expired.
        const feedB = byId.get('seed-source-002')!
        expect(feedB.source).toBe('Caramel Sample Feed B')
        expect(feedB.websites).toEqual(['codecademy.com'])
        expect(feedB.status).toBe('ACTIVE')
        expect(feedB.total_coupons).toBe(6)
        expect(feedB.total_used).toBe(617)
        expect(feedB.total_expired).toBe(0)

        // ebay+amazon source: a concurrent suite can only ADD ebay coupons
        // (times_used 0), so assert lower bounds on the seeded aggregates and
        // that they are plain numbers (the ::int cast).
        const feedA = byId.get('seed-source-001')!
        expect(feedA.websites).toEqual(['ebay.com', 'amazon.com'])
        expect(typeof feedA.total_coupons).toBe('number')
        expect(feedA.total_coupons).toBeGreaterThanOrEqual(16)
        expect(feedA.total_used).toBeGreaterThanOrEqual(2357)
        expect(feedA.total_expired).toBeGreaterThanOrEqual(2)
    })
})

describe('listStoreSitemapEntries — per-site visible aggregates for the sitemap (real pg :58005)', () => {
    it('returns one row per visible site, sorted by site, with an ::int count that matches listCoupons and a real Date last_updated', async () => {
        const rows = await listStoreSitemapEntries(5000)

        // Non-null sites only, ascending — the GROUP BY / ORDER BY held for real.
        const sites = rows.map(r => r.site)
        for (const site of sites) expect(site).toBeTruthy()
        expect(sites).toEqual([...sites].sort())

        // codecademy.com is the store no other suite writes to, so its
        // aggregate is asserted exactly against the SAME visibility predicate
        // listCoupons applies: the sitemap count must equal the page count.
        const codecademy = rows.find(r => r.site === 'codecademy.com')
        expect(codecademy).toBeDefined()
        expect(Number.isInteger(codecademy!.coupon_count)).toBe(true)
        expect(codecademy!.coupon_count).toBeGreaterThan(0)
        expect(codecademy!.last_updated).toBeInstanceOf(Date)
        expect(Number.isNaN(codecademy!.last_updated.getTime())).toBe(false)
        const { total } = await listCoupons({
            baseSite: 'codecademy.com',
            limit: 1,
            skip: 0,
        })
        // listCoupons also matches subdomain rows (LIKE '%.codecademy.com'),
        // so compare against the sum over every raw site under that base.
        const underBase = rows
            .filter(
                r =>
                    r.site === 'codecademy.com' ||
                    r.site.endsWith('.codecademy.com'),
            )
            .reduce((sum, r) => sum + r.coupon_count, 0)
        expect(underBase).toBe(total)

        // LIMIT is bound (the sitemap's 5000 cap is a real bound, not decoration).
        expect(await listStoreSitemapEntries(2)).toHaveLength(2)
    })
})
