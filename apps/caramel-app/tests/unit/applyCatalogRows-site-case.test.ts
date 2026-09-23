import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the ONE write-side normalization applyCatalogRows performs: `site` is
// stored lowercased. Domains are case-insensitive, but the store-page reads
// match `site = $base OR site LIKE '%.' || $base` case-SENSITIVELY on a
// lowercased $base (resolveStoreDomain), so a mixed-case producer value
// (prod 2026-09-11: `eNasco.com`, `Brooklinen.com`) was unreachable from its
// own canonical page. The transaction is mocked so no DB is touched; the
// INSERT's bound VALUES are captured off the composed Prisma.Sql and asserted
// directly. The real round-trip is pinned against live Postgres in
// tests/integration/ingest-catalog.itest.ts.

type Captured = { sql: string; values: unknown[] }

const { txMock, captured } = vi.hoisted(() => {
    const captured: Captured[] = []
    const txMock = {
        // No pre-existing rows for any pushed id → every row is an insert.
        $queryRaw: vi.fn(async () => []),
        coupon: { count: vi.fn(async () => 0) },
        $executeRaw: vi.fn(async (arg: Captured) => {
            captured.push({ sql: arg.sql, values: arg.values })
            return 1
        }),
    }
    return { txMock, captured }
})

vi.mock('@/lib/prisma', () => ({
    default: {
        $transaction: (fn: (tx: typeof txMock) => Promise<unknown>) =>
            fn(txMock),
    },
}))

type IngestCoupon = IngestCatalogPayload['coupons'][number]

function coupon(id: string, site: string | null): IngestCoupon {
    return {
        id,
        code: `CODE-${id}`,
        site,
        title: `t-${id}`,
        description: 'd',
        rating: 0,
        discount_type: null,
        discount_amount: null,
        expiry: null,
        expired: false,
        times_used: 0,
        last_time_used: null,
        status: 'valid',
        verification_message: null,
        updated_at: new Date('2026-09-12T00:00:00.000Z'),
    }
}

beforeEach(() => {
    captured.length = 0
    txMock.$queryRaw.mockClear()
    txMock.$executeRaw.mockClear()
})

describe('applyCatalogRows — site is lowercased on write', () => {
    it('binds the lowercase site for mixed-case producer values and leaves a null site null', async () => {
        const result = await applyCatalogRows({
            coupons: [
                coupon('800000101', 'eNasco.com'),
                coupon('800000102', 'Brooklinen.com'),
                coupon('800000103', 'already-lower.com'),
                coupon('800000104', null),
            ],
            storeConfigs: [],
            sources: [],
            force: false,
        })
        expect(result.gated).toBe(false)

        const insert = captured.find(c => c.sql.includes('INSERT INTO coupons'))
        expect(insert).toBeDefined()
        const bound = insert!.values

        expect(bound).toContain('enasco.com')
        expect(bound).toContain('brooklinen.com')
        expect(bound).toContain('already-lower.com')
        expect(bound).not.toContain('eNasco.com')
        expect(bound).not.toContain('Brooklinen.com')
        // The nullable column stays nullable — null is not turned into ''.
        expect(bound).toContain(null)
        // Only `site` is normalized: the code keeps its producer casing.
        expect(bound).toContain('CODE-800000101')
    })
})
