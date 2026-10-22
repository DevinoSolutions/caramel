import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the referral guard in applyCatalogRows (T-2956): a personal referral
// code (coupons.ts isReferralCoupon) is never INSERTED (counted
// skippedReferral), and one already stored is written with expired = true so it
// leaves through the ordinary per-row tombstone path (counted `tombstoned`,
// measured by the 20% gate). Everything else stays raw. Same mocking pattern as
// applyCatalogRows-site-case.test.ts: the transaction is mocked and the INSERT's
// bound VALUES are read off the composed Prisma.Sql.

type Captured = { sql: string; values: unknown[] }
type StoredRow = {
    id: string
    site: string | null
    code: string
    expired: boolean
    status: string
    updated_at: Date
}

const { txMock, captured, state } = vi.hoisted(() => {
    const captured: Captured[] = []
    const state = { stored: [] as StoredRow[], visibleCount: 0 }
    const txMock = {
        $queryRaw: vi.fn(async () => state.stored),
        coupon: { count: vi.fn(async () => state.visibleCount) },
        $executeRaw: vi.fn(async (arg: Captured) => {
            captured.push({ sql: arg.sql, values: arg.values })
            return 1
        }),
    }
    return { txMock, captured, state }
})

vi.mock('@/lib/prisma', () => ({
    default: {
        $transaction: (fn: (tx: typeof txMock) => Promise<unknown>) =>
            fn(txMock),
    },
}))

type IngestCoupon = IngestCatalogPayload['coupons'][number]

// Bound parameters per coupon tuple in the INSERT, and the positions of the
// columns read back (id, code, site, title, description, rating,
// discount_type, discount_amount, expiry, expired, ...).
const TUPLE_WIDTH = 17
const ID_AT = 0
const EXPIRED_AT = 9
const STATUS_AT = 12

const PUSH_AT = new Date('2026-10-17T00:00:00.000Z')
const STORED_AT = new Date('2026-10-01T00:00:00.000Z')

function coupon(
    id: string,
    title: string,
    overrides: Partial<IngestCoupon> = {},
): IngestCoupon {
    return {
        id,
        code: `CODE-${id}`,
        site: 'example.com',
        title,
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
        updated_at: PUSH_AT,
        ...overrides,
    }
}

function stored(id: string, overrides: Partial<StoredRow> = {}): StoredRow {
    // Same site and code as coupon(id, ...), so the id-identity guard sees the
    // same coupon (applyCatalogRows-id-mismatch.test.ts covers a mismatch).
    return {
        id,
        site: 'example.com',
        code: `CODE-${id}`,
        expired: false,
        status: 'valid',
        updated_at: STORED_AT,
        ...overrides,
    }
}

/** The coupons INSERT's tuples as { id, expired, status }, in order. */
function writtenCoupons(): Array<{
    id: unknown
    expired: unknown
    status: unknown
}> {
    const insert = captured.find(c => c.sql.includes('INSERT INTO coupons'))
    if (!insert) return []
    const out: Array<{ id: unknown; expired: unknown; status: unknown }> = []
    for (let i = 0; i < insert.values.length; i += TUPLE_WIDTH) {
        out.push({
            id: insert.values[i + ID_AT],
            expired: insert.values[i + EXPIRED_AT],
            status: insert.values[i + STATUS_AT],
        })
    }
    return out
}

function push(coupons: IngestCoupon[], force = false) {
    return applyCatalogRows({ coupons, storeConfigs: [], sources: [], force })
}

beforeEach(() => {
    captured.length = 0
    state.stored = []
    state.visibleCount = 0
    txMock.$queryRaw.mockClear()
    txMock.$executeRaw.mockClear()
})

describe('applyCatalogRows - referral guard', () => {
    it('does not insert a new referral row and counts it as skippedReferral', async () => {
        const result = await push([
            coupon('800000201', 'Refer a Friend Select Items'),
            coupon('800000202', 'Get 10% Off Your Purchase'),
        ])

        expect(result.gated).toBe(false)
        expect(result.coupons).toEqual({
            inserted: 1,
            updated: 0,
            skippedOlder: 0,
            tombstoned: 0,
            skippedReferral: 1,
            skippedIdMismatch: 0,
        })
        expect(writtenCoupons()).toEqual([
            { id: '800000202', expired: false, status: 'valid' },
        ])
        const insert = captured.find(c => c.sql.includes('INSERT INTO coupons'))
        expect(insert?.values).not.toContain('800000201')
        expect(insert?.values).not.toContain('CODE-800000201')
    })

    it('issues no coupons INSERT when every pushed row is a new referral row', async () => {
        const result = await push([
            coupon('800000211', 'Referral Discount, Code In The Link'),
        ])

        expect(result.coupons.skippedReferral).toBe(1)
        expect(result.coupons.inserted).toBe(0)
        expect(captured).toHaveLength(0)
    })

    it('writes an already-stored visible referral row with expired = true and counts it as tombstoned', async () => {
        state.stored = [stored('800000221')]
        state.visibleCount = 100

        const result = await push([
            coupon('800000221', 'Enjoy 20% off with a friend referral'),
        ])

        expect(result.gated).toBe(false)
        expect(result.coupons).toEqual({
            inserted: 0,
            updated: 1,
            skippedOlder: 0,
            tombstoned: 1,
            skippedReferral: 0,
            skippedIdMismatch: 0,
        })
        expect(writtenCoupons()).toEqual([
            { id: '800000221', expired: true, status: 'valid' },
        ])
    })

    it('forces only expired: the pushed status stays raw', async () => {
        state.stored = [stored('800000231')]
        state.visibleCount = 100

        await push([
            coupon('800000231', 'Refer a friend', {
                status: 'valid_restricted_cat',
            }),
        ])

        expect(writtenCoupons()).toEqual([
            { id: '800000231', expired: true, status: 'valid_restricted_cat' },
        ])
    })

    it('does not count a stored referral row that was already expired as a tombstone', async () => {
        state.stored = [stored('800000241', { expired: true })]
        state.visibleCount = 100

        const result = await push([coupon('800000241', 'Refer a friend')])

        expect(result.coupons.updated).toBe(1)
        expect(result.coupons.tombstoned).toBe(0)
        expect(writtenCoupons()).toEqual([
            { id: '800000241', expired: true, status: 'valid' },
        ])
    })

    it('still applies only-if-newer to a stored referral row', async () => {
        state.stored = [stored('800000251', { updated_at: PUSH_AT })]
        state.visibleCount = 100

        const result = await push([
            coupon('800000251', 'Refer a friend', {
                updated_at: new Date('2026-09-01T00:00:00.000Z'),
            }),
        ])

        expect(result.coupons.skippedOlder).toBe(1)
        expect(result.coupons.tombstoned).toBe(0)
        expect(captured).toHaveLength(0)
    })

    it('leaves non-referral rows untouched, including a normal tombstone', async () => {
        state.stored = [stored('800000261'), stored('800000262')]
        state.visibleCount = 100

        const result = await push([
            coupon('800000261', 'Get 10% Off Your Purchase'),
            coupon('800000262', 'Avis Preferred members', { expired: true }),
            coupon('800000263', "Musician's Friend code"),
        ])

        expect(result.coupons).toEqual({
            inserted: 1,
            updated: 2,
            skippedOlder: 0,
            tombstoned: 1,
            skippedReferral: 0,
            skippedIdMismatch: 0,
        })
        expect(writtenCoupons()).toEqual([
            { id: '800000261', expired: false, status: 'valid' },
            { id: '800000262', expired: true, status: 'valid' },
            { id: '800000263', expired: false, status: 'valid' },
        ])
    })

    it('trips the 20% gate when referral tombstones push over the threshold, writing nothing', async () => {
        state.stored = [
            stored('800000271'),
            stored('800000272'),
            stored('800000273'),
        ]
        state.visibleCount = 10

        const result = await push([
            coupon('800000271', 'Refer a friend'),
            coupon('800000272', 'Referral code in the link'),
            coupon('800000273', 'Invite code'),
        ])

        expect(result.gated).toBe(true)
        expect(result.gate?.wouldTombstone).toBe(3)
        expect(result.gate?.visibleBefore).toBe(10)
        expect(captured).toHaveLength(0)
    })

    it('lets the same push through with force', async () => {
        state.stored = [
            stored('800000281'),
            stored('800000282'),
            stored('800000283'),
        ]
        state.visibleCount = 10

        const result = await push(
            [
                coupon('800000281', 'Refer a friend'),
                coupon('800000282', 'Referral code in the link'),
                coupon('800000283', 'Invite code'),
            ],
            true,
        )

        expect(result.gated).toBe(false)
        expect(result.coupons.tombstoned).toBe(3)
        expect(writtenCoupons().every(w => w.expired === true)).toBe(true)
    })
})
