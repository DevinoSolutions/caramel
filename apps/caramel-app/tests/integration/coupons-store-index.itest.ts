import { Prisma } from '@/generated/prisma/client'
import {
    countCouponsForStores,
    isKnownStore,
    listCoupons,
    listStoreCoupons,
} from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Store-scoped coupon reads through the REAL onStoreSql (couponsRepo.ts) on a
// live migrated Postgres:
//   (a) semantics — exact site, any subdomain, NEVER a mere suffix, and a store
//       containing `_` / `%` / `\` matches only itself (the suffix arm is
//       `reverse(site) LIKE <escaped reverse('.' || store)> || '%' ESCAPE '\');
//   (b) plan — with a realistic number of rows, the store reads are answered
//       by coupons_site_idx + coupons_site_reverse_idx (BitmapOr), not the
//       Parallel Seq Scan over every coupon that `right(site, …) = '.' || store`
//       forced (prod, 2026-10-10: 40-65 ms per read, two reads per store page).
//
// Private fixtures: ids 977000xxx (semantics) and 97710xxxxx (bulk), removed
// afterwards. Run serially with the other integration files (see the config).

const SEMANTIC_PREFIX = '977000'
const BULK_PREFIX = '97710'

const sem = (n: number) => `${SEMANTIC_PREFIX}${String(n).padStart(3, '0')}`

type Row = { id: string; site: string }

// base -> the sites that must / must not be owned by it.
const EBAY = 'idx-ebay.test'
const UNDERSCORE = 'a_cd.test'
const PERCENT = 'a%d.test'
const BACKSLASH = 'a\\d.test'

const ROWS: Row[] = [
    // idx-ebay.test: exact + subdomains match; suffix-only lookalikes do not.
    { id: sem(1), site: EBAY },
    { id: sem(2), site: `shop.${EBAY}` },
    { id: sem(3), site: `a.b.${EBAY}` },
    { id: sem(4), site: `not${EBAY}` }, // notidx-ebay.test: suffix, no dot
    { id: sem(5), site: `${EBAY}.evil` }, // base as a prefix / middle
    { id: sem(6), site: `x-${EBAY}` },
    { id: sem(7), site: 'ebay.test' }, // the base's own parent: not a subdomain of it
    // `_` is not a wildcard.
    { id: sem(10), site: UNDERSCORE },
    { id: sem(11), site: `shop.${UNDERSCORE}` },
    { id: sem(12), site: 'abcd.test' },
    { id: sem(13), site: 'shop.abcd.test' },
    // `%` is not a wildcard.
    { id: sem(20), site: PERCENT },
    { id: sem(21), site: `shop.${PERCENT}` },
    { id: sem(22), site: 'axyd.test' },
    { id: sem(23), site: 'shop.axyd.test' },
    { id: sem(24), site: 'ad.test' },
    // `\` is not an escape.
    { id: sem(30), site: BACKSLASH },
    { id: sem(31), site: `shop.${BACKSLASH}` },
    { id: sem(32), site: 'ad.test.x' },
    { id: sem(33), site: 'a_d.test' },
]
const SEMANTIC_IDS = ROWS.map(r => r.id)

const idsFor = (...n: number[]) => n.map(sem).sort()

async function cleanup() {
    await prisma.$executeRaw`DELETE FROM coupons WHERE id LIKE ${`${SEMANTIC_PREFIX}%`} OR id LIKE ${`${BULK_PREFIX}%`}`
}

beforeAll(async () => {
    await cleanup()
    await prisma.coupon.createMany({
        data: ROWS.map(r => ({
            id: r.id,
            code: `IDX${r.id}`,
            site: r.site,
            title: `Store index fixture ${r.id}`,
            description: 'fixture',
            rating: 1,
            status: 'valid',
        })),
    })
})

afterAll(async () => {
    await cleanup()
    await prisma.$executeRaw`ANALYZE coupons`
    await prisma.$disconnect()
})

async function storeIds(base: string): Promise<string[]> {
    const { coupons } = await listStoreCoupons(base, 100)
    return coupons
        .map(c => c.id)
        .filter(id => SEMANTIC_IDS.includes(id))
        .sort()
}

describe('onStoreSql semantics (real pg)', () => {
    it('matches the exact site and every subdomain, not a mere suffix', async () => {
        expect(await storeIds(EBAY)).toEqual(idsFor(1, 2, 3))
    })

    it('listCoupons with a site agrees with listStoreCoupons', async () => {
        const { coupons, total } = await listCoupons({
            baseSite: EBAY,
            limit: 100,
            skip: 0,
        })
        expect(
            coupons
                .map(c => c.id)
                .filter(id => SEMANTIC_IDS.includes(id))
                .sort(),
        ).toEqual(idsFor(1, 2, 3))
        expect(total).toBe(3)
    })

    it('a store containing "_" does not wildcard', async () => {
        expect(await storeIds(UNDERSCORE)).toEqual(idsFor(10, 11))
    })

    it('a store containing "%" does not wildcard', async () => {
        expect(await storeIds(PERCENT)).toEqual(idsFor(20, 21))
    })

    it('a store containing a backslash does not escape its neighbour', async () => {
        expect(await storeIds(BACKSLASH)).toEqual(idsFor(30, 31))
    })

    it('the column-store path (followed-store counts, a join) agrees', async () => {
        const counts = await countCouponsForStores([
            EBAY,
            UNDERSCORE,
            PERCENT,
            BACKSLASH,
            'nothing-here.test',
        ])
        // The seeded catalog never uses these private .test hosts, so
        // the counts are exactly the fixture matches.
        expect(counts.get(EBAY)).toBe(3)
        expect(counts.get(UNDERSCORE)).toBe(2)
        expect(counts.get(PERCENT)).toBe(2)
        expect(counts.get(BACKSLASH)).toBe(2)
        expect(counts.get('nothing-here.test')).toBe(0)
    })

    it('isKnownStore: a subdomain-only store is known, a lookalike suffix is not', async () => {
        expect(await isKnownStore(EBAY)).toBe(true)
        expect(await isKnownStore('dx-ebay.test')).toBe(false)
        expect(await isKnownStore('ebay.test')).toBe(true) // sem(7) exact
        expect(await isKnownStore('b.idx-ebay.test')).toBe(true) // a.b. subdomain
        expect(await isKnownStore('x.test')).toBe(false)
    })
})

describe('store reads use the indexes (real pg, EXPLAIN)', () => {
    const SITES = 2000
    const ROWS_TOTAL = 20_000
    const shop = (n: number) => `perf-shop${n}.test`

    beforeAll(async () => {
        // 20k rows over 2000 stores; every 7th row sits on a `www.` subdomain, so
        // each store has exact AND subdomain rows. Then ANALYZE so the planner has
        // real statistics (a never-analyzed table can plan anything).
        await prisma.$executeRaw`
            INSERT INTO coupons (id, code, site, title, description, rating, status, expired, created_at, updated_at)
            SELECT ${BULK_PREFIX} || lpad(g::text, 5, '0'),
                   'PERF' || g,
                   CASE WHEN g % 7 = 0 THEN 'www.' ELSE '' END || 'perf-shop' || (g % ${SITES}) || '.test',
                   'Bulk fixture ' || g, 'fixture', 1, 'valid', false, now(), now()
            FROM generate_series(1, ${ROWS_TOTAL}) AS g
        `
        await prisma.$executeRaw`ANALYZE coupons`
    })

    // Run the store reads for real, recording the Prisma.Sql each one handed to
    // $queryRaw, so the plan under test is the production query's, not a copy.
    async function captureStoreQueries(
        run: () => Promise<unknown>,
    ): Promise<Prisma.Sql[]> {
        const spy = vi.spyOn(prisma, '$queryRaw')
        try {
            await run()
            return spy.mock.calls
                .map(call => call[0] as Prisma.Sql)
                .filter(q => q.sql.includes('FROM coupons'))
        } finally {
            spy.mockRestore()
        }
    }

    async function plan(query: Prisma.Sql): Promise<string> {
        const rows = (await prisma.$queryRaw(
            Prisma.sql`EXPLAIN ${query}`,
        )) as Array<{ 'QUERY PLAN': string }>
        return rows.map(r => r['QUERY PLAN']).join('\n')
    }

    it('listStoreCoupons: the list and the aggregate are index-backed, not a Seq Scan on coupons', async () => {
        const queries = await captureStoreQueries(() =>
            listStoreCoupons(shop(42), 20),
        )
        expect(queries).toHaveLength(2)
        for (const q of queries) {
            const text = await plan(q)
            expect(text).not.toMatch(/Seq Scan on coupons/)
            expect(text).toMatch(/coupons_site_idx/)
            expect(text).toMatch(/coupons_site_reverse_idx/)
        }
    })

    it('listCoupons with a site: the list and the count are index-backed', async () => {
        const queries = await captureStoreQueries(() =>
            listCoupons({ baseSite: shop(42), limit: 20, skip: 0 }),
        )
        expect(queries).toHaveLength(2)
        for (const q of queries) {
            const text = await plan(q)
            expect(text).not.toMatch(/Seq Scan on coupons/)
            expect(text).toMatch(/coupons_site_reverse_idx/)
        }
    })

    it('returns exactly what the old right(site, …) predicate returned, for stores with and without subdomain rows', async () => {
        for (const base of [
            shop(0),
            shop(7),
            shop(1999),
            'perf-shop5000.test',
        ]) {
            const [oracle] = await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM coupons
                WHERE id LIKE ${`${BULK_PREFIX}%`}
                  AND (site = ${base} OR right(site, length(${base}) + 1) = '.' || ${base})
            `
            const { total } = await listStoreCoupons(base, 20)
            expect(total, base).toBe(oracle?.n)
        }
        // shop(0) is hit by exact rows AND `www.` rows, so the arm under test is live.
        const { total } = await listStoreCoupons(shop(0), 20)
        expect(total).toBeGreaterThan(0)
    })
})
