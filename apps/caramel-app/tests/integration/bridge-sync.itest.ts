import prisma from '@/lib/prisma'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBridge } from '../../scripts/bridge-sync'

// W4-D4 integration — the FULL bridge proven end-to-end against live local
// Postgres (:28005), WITHOUT the real external caramel_coupons DB. We stand the
// external-shaped tables up in a dedicated `bridge_ext_test` schema and point a
// porsager client (scoped to that schema via `-c search_path=`) at them, exactly
// as runBridge() would see the real external DB. runBridge then reads (its
// verbatim SELECTs) -> maps -> applyCatalogRows() writes the APP tables (public.*,
// prisma's datasource default). The two never overlap: the injected client reads
// bridge_ext_test.*, prisma writes public.* — the intended separation, asserted
// below. ALL data is SYNTHETIC (loudly labelled) in a private 7700000xx coupon-id
// range + a unique store/source that cannot collide with the seed (9000000xx) or
// any other itest.
//
// TWO DIFFERENT WRITE DISCIPLINES: the bridge SCRIPT only ever SELECTs the
// external DB (strictly read-only). This TEST HARNESS freely CREATEs / seeds /
// mutates its OWN local `bridge_ext_test` FIXTURE schema — a fixture is not the
// real external DB, so the read-only rule (which governs the real
// COUPONS_DATABASE_URL target) does not apply to it.

const EXT_SCHEMA = 'bridge_ext_test'
const COUPON_IDS = ['770000001', '770000002', '770000003']
const STORE_NAME = 'synthetic-bridge-store.example'
const SOURCE_ID = 'synthetic-bridge-source-7700'

// Distinct stored-catalog timestamps (the only-if-newer ordering key).
const T1 = '2026-07-10T00:00:00.000Z'
const T2 = '2026-07-11T00:00:00.000Z'
const T3 = '2026-07-12T00:00:00.000Z'

let externalTestSql: postgres.Sql

async function cleanupAppRows() {
    await prisma.coupon.deleteMany({ where: { id: { in: COUPON_IDS } } })
    await prisma.storeConfig.deleteMany({ where: { storeName: STORE_NAME } })
    await prisma.source.deleteMany({ where: { id: SOURCE_ID } })
}

beforeAll(async () => {
    // ONE dedicated connection (max:1) whose search_path is the test schema, set
    // at connection STARTUP so it survives any reconnect (a runtime `SET` could
    // land on a different pooled socket). prepare:false mirrors the real bridge
    // client. Reads/writes here target bridge_ext_test.*; prisma (DATABASE_URL,
    // default search_path=public) is a SEPARATE connection writing public.*.
    //
    // Strip the query string before handing DATABASE_URL to porsager: this var
    // is PRISMA-shaped (CI's scripts/ci-env.ts writes `?schema=public`), and
    // Prisma's `?schema=` is NOT a libpq startup parameter — porsager forwards it
    // verbatim and Postgres rejects it with `unrecognized configuration parameter
    // "schema"`. The search_path is (correctly) supplied the porsager-native way
    // via connection.options below, so Prisma's query string is redundant here.
    // The real bridge's main() needs no such strip: it opens COUPONS_DATABASE_URL,
    // a porsager-native URL with no `?schema=`.
    const externalUrl = process.env.DATABASE_URL!.split('?')[0]
    externalTestSql = postgres(externalUrl, {
        max: 1,
        prepare: false,
        connection: { options: `-c search_path=${EXT_SCHEMA}` },
    })

    // Clean slate so the suite is idempotent / re-runnable.
    await externalTestSql.unsafe(`DROP SCHEMA IF EXISTS ${EXT_SCHEMA} CASCADE`)
    await externalTestSql.unsafe(`CREATE SCHEMA ${EXT_SCHEMA}`)
    await cleanupAppRows()

    // External-shaped tables (verbatim column sets the bridge SELECTs target).
    // coupons.id is int8/bigint like the real external catalog, so porsager
    // returns it as a STRING — exactly what ExternalCouponRow.id expects. All DDL
    // + seed here is fully-literal SYNTHETIC SQL (no user input) via .unsafe().
    await externalTestSql.unsafe(`
        CREATE TABLE ${EXT_SCHEMA}.coupons (
            id bigint PRIMARY KEY,
            code text NOT NULL,
            site text,
            title text NOT NULL,
            description text NOT NULL,
            rating double precision NOT NULL DEFAULT 0,
            discount_type text,
            discount_amount double precision,
            expiry text,
            expired boolean NOT NULL DEFAULT false,
            times_used integer NOT NULL DEFAULT 0,
            last_time_used timestamptz,
            status text NOT NULL,
            verification_message text,
            updated_at timestamptz NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `)
    await externalTestSql.unsafe(`
        CREATE TABLE ${EXT_SCHEMA}.verification_stores (
            id bigint PRIMARY KEY,
            store_name text NOT NULL
        )
    `)
    await externalTestSql.unsafe(`
        CREATE TABLE ${EXT_SCHEMA}.store_verification_configs (
            id bigserial PRIMARY KEY,
            store_id bigint NOT NULL,
            is_active boolean NOT NULL DEFAULT true,
            priority integer NOT NULL DEFAULT 0,
            metadata jsonb,
            show_input_xpath text,
            dismiss_button_xpath text,
            coupon_input_xpath text,
            apply_button_xpath text,
            price_container_xpath text,
            success_indicator_xpath text,
            error_indicator_xpath text,
            coupon_remove_xpath text,
            updated_at timestamptz NOT NULL
        )
    `)
    await externalTestSql.unsafe(`
        CREATE TABLE ${EXT_SCHEMA}.sources (
            id text PRIMARY KEY,
            source text NOT NULL,
            websites text[] NOT NULL DEFAULT '{}',
            status text NOT NULL,
            updated_at timestamptz NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `)

    // ---- SYNTHETIC seed ------------------------------------------------------
    // 3 coupons with DISTINCT updated_at. status 'pending' keeps them out of
    // coupons-read.itest.ts's status='valid' census; the 7700000xx id range keeps
    // them out of every suite's id-scoped assertions.
    await externalTestSql.unsafe(`
        INSERT INTO ${EXT_SCHEMA}.coupons
            (id, code, site, title, description, rating, discount_type, discount_amount, expiry, expired, times_used, last_time_used, status, verification_message, updated_at, created_at)
        VALUES
            (770000001, 'SYNTHETIC-A', '${STORE_NAME}', 'SYNTHETIC A', 'synthetic bridge coupon A', 4.1, 'percentage', 10, '2027-01-01', false, 3, '${T1}'::timestamptz, 'pending', 'SYNTHETIC verified A', '${T1}'::timestamptz, '${T1}'::timestamptz),
            (770000002, 'SYNTHETIC-B', '${STORE_NAME}', 'SYNTHETIC B', 'synthetic bridge coupon B', 4.2, 'fixed', 5, NULL, false, 0, NULL, 'pending', NULL, '${T2}'::timestamptz, '${T2}'::timestamptz),
            (770000003, 'SYNTHETIC-C', '${STORE_NAME}', 'SYNTHETIC C', 'synthetic bridge coupon C', 4.3, NULL, NULL, NULL, false, 1, NULL, 'pending', NULL, '${T3}'::timestamptz, '${T3}'::timestamptz)
    `)
    // 1 store: a verification_stores row + one active store_verification_configs
    // row carrying coupon_input + apply_button xpaths (metadata NULL → the
    // COALESCE(..., 'true') branch → passes the extension_compatible filter).
    await externalTestSql.unsafe(`
        INSERT INTO ${EXT_SCHEMA}.verification_stores (id, store_name)
        VALUES (7700, '${STORE_NAME}')
    `)
    await externalTestSql.unsafe(`
        INSERT INTO ${EXT_SCHEMA}.store_verification_configs
            (store_id, is_active, priority, metadata, show_input_xpath, dismiss_button_xpath, coupon_input_xpath, apply_button_xpath, price_container_xpath, success_indicator_xpath, error_indicator_xpath, coupon_remove_xpath, updated_at)
        VALUES
            (7700, true, 10, NULL, '//button[@id="show"]', NULL, '//input[@id="code"]', '//button[@id="apply"]', '//div[@id="total"]', NULL, NULL, NULL, '${T2}'::timestamptz)
    `)
    // 1 source. status is a SYNTHETIC non-ACTIVE value so it can never appear in
    // listActiveSources() (WHERE status='ACTIVE'), which coupons-read.itest.ts
    // asserts exactly.
    await externalTestSql.unsafe(`
        INSERT INTO ${EXT_SCHEMA}.sources (id, source, websites, status, updated_at, created_at)
        VALUES ('${SOURCE_ID}', 'SYNTHETIC Bridge Feed', ARRAY['${STORE_NAME}']::text[], 'SYNTHETIC_BRIDGE', '${T2}'::timestamptz, '${T2}'::timestamptz)
    `)
})

afterAll(async () => {
    // Tear the fixture schema down AND remove the app-side rows the bridge wrote,
    // so the suite is idempotent and never perturbs coupons-read.itest.ts.
    await externalTestSql.unsafe(`DROP SCHEMA IF EXISTS ${EXT_SCHEMA} CASCADE`)
    await cleanupAppRows()
    await externalTestSql.end({ timeout: 5 })
    await prisma.$disconnect()
})

describe('bridge sync — external SELECT -> map -> applyCatalogRows -> app tables (real pg :28005)', () => {
    it('Test 1 — initial replay inserts the mapped catalog into the app tables', async () => {
        const result = await runBridge(externalTestSql)
        expect(result.gated).toBe(false)
        if (result.gated) return

        expect(result.coupons.inserted).toBe(3)
        expect(result.storeConfigs.upserted).toBe(1)
        expect(result.sources.upserted).toBe(1)

        // Coupon mapped shape: TEXT id stays a string, float8/int columns are
        // numbers, updated_at carried as the external Date, RAW discount_type.
        const a = await prisma.coupon.findUnique({ where: { id: '770000001' } })
        expect(a).not.toBeNull()
        expect(a!.code).toBe('SYNTHETIC-A')
        expect(a!.site).toBe(STORE_NAME)
        expect(a!.rating).toBeCloseTo(4.1, 5)
        expect(a!.discountType).toBe('percentage')
        expect(a!.discountAmount).toBe(10)
        expect(a!.timesUsed).toBe(3)
        expect(a!.status).toBe('pending')
        expect(a!.updatedAt.getTime()).toBe(new Date(T1).getTime())

        // Flattened store_config: store_name + the xpaths, a null xpath preserved.
        const sc = await prisma.storeConfig.findUnique({
            where: { storeName: STORE_NAME },
        })
        expect(sc).not.toBeNull()
        expect(sc!.couponInputXpath).toBe('//input[@id="code"]')
        expect(sc!.applyButtonXpath).toBe('//button[@id="apply"]')
        expect(sc!.showInputXpath).toBe('//button[@id="show"]')
        expect(sc!.dismissButtonXpath).toBeNull()

        // Source: websites[] carried through, synthetic status preserved.
        const src = await prisma.source.findUnique({ where: { id: SOURCE_ID } })
        expect(src).not.toBeNull()
        expect(src!.source).toBe('SYNTHETIC Bridge Feed')
        expect(src!.websites).toEqual([STORE_NAME])
        expect(src!.status).toBe('SYNTHETIC_BRIDGE')
    })

    it('Test 2 — re-running the same replay is idempotent (only-if-newer writes no new rows)', async () => {
        const before = await prisma.coupon.findMany({
            where: { id: { in: COUPON_IDS } },
            orderBy: { id: 'asc' },
        })

        const result = await runBridge(externalTestSql)
        expect(result.gated).toBe(false)
        if (result.gated) return

        // Nothing NEW inserted, nothing tombstoned. (`updated` is 3 here:
        // applyCatalogRows is only-if-newer INCLUSIVE — `excluded.updated_at >=
        // stored` — so equal-timestamp rows re-apply as no-op overwrites. The
        // idempotency guarantee is "no new/changed data", proven by inserted=0 +
        // the byte-identical rows below.)
        expect(result.coupons.inserted).toBe(0)
        expect(result.coupons.tombstoned).toBe(0)

        const after = await prisma.coupon.findMany({
            where: { id: { in: COUPON_IDS } },
            orderBy: { id: 'asc' },
        })
        expect(after).toHaveLength(3)
        expect(after.map(c => c.title)).toEqual(before.map(c => c.title))
        expect(after.map(c => c.updatedAt.getTime())).toEqual(
            before.map(c => c.updatedAt.getTime()),
        )
    })

    it('Test 3 — a newer external row updates only itself; strictly-older rows are skipped', async () => {
        // Mutate the LOCAL fixture: bump coupon A NEWER + change its title; push
        // B and C strictly OLDER than the stored rows, so only-if-newer must skip
        // them (the realistic "stale external replay vs a newer stored row" case).
        const NEWER = '2026-07-20T00:00:00.000Z'
        const OLDER = '2026-07-01T00:00:00.000Z'
        await externalTestSql.unsafe(`
            UPDATE ${EXT_SCHEMA}.coupons
            SET title = 'SYNTHETIC A UPDATED', updated_at = '${NEWER}'::timestamptz
            WHERE id = 770000001
        `)
        await externalTestSql.unsafe(`
            UPDATE ${EXT_SCHEMA}.coupons
            SET title = 'SYNTHETIC B STALE', updated_at = '${OLDER}'::timestamptz
            WHERE id = 770000002
        `)
        await externalTestSql.unsafe(`
            UPDATE ${EXT_SCHEMA}.coupons
            SET title = 'SYNTHETIC C STALE', updated_at = '${OLDER}'::timestamptz
            WHERE id = 770000003
        `)

        const result = await runBridge(externalTestSql)
        expect(result.gated).toBe(false)
        if (result.gated) return

        expect(result.coupons.updated).toBe(1)
        expect(result.coupons.skippedOlder).toBe(2)

        // A applied: new title + bumped updated_at.
        const a = await prisma.coupon.findUnique({ where: { id: '770000001' } })
        expect(a!.title).toBe('SYNTHETIC A UPDATED')
        expect(a!.updatedAt.getTime()).toBe(new Date(NEWER).getTime())

        // B and C untouched: the stale push was skipped, original values kept.
        const b = await prisma.coupon.findUnique({ where: { id: '770000002' } })
        expect(b!.title).toBe('SYNTHETIC B')
        expect(b!.updatedAt.getTime()).toBe(new Date(T2).getTime())

        const c = await prisma.coupon.findUnique({ where: { id: '770000003' } })
        expect(c!.title).toBe('SYNTHETIC C')
        expect(c!.updatedAt.getTime()).toBe(new Date(T3).getTime())
    })
})
