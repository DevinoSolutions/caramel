import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import {
    type IngestCatalogPayload,
    IngestCatalogPayloadSchema,
} from '@/lib/catalog/ingestSchemas'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the `new_customers_only` coupon flag (owner decision 2026-10-19, T-2956):
// a code that only works for a brand-new account (the referral codes the owner
// kept because the new customer does get a discount) carries a "New customers
// only" label. The flag is OPTIONAL on the wire and absent means "no opinion":
// a push that omits it (every pipeline push today) must never clear a flag set
// in the app. A referral-worded row that IS flagged (pushed or stored) is a
// kept new-customer offer, so the referral filter does not remove it. Same
// mocking pattern as applyCatalogRows-id-mismatch.test.ts.

type Captured = { sql: string; values: unknown[] }
type StoredRow = {
    id: string
    site: string | null
    code: string
    expired: boolean
    status: string
    updated_at: Date
    new_customers_only: boolean | null
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

const TUPLE_WIDTH = 17
const ID_AT = 0
const EXPIRED_AT = 9
const NEW_CUSTOMERS_ONLY_AT = 16

const PUSH_AT = new Date('2026-10-19T10:05:30.000Z')
const STORED_AT = new Date('2026-08-03T02:33:07.000Z')

function coupon(
    id: string,
    overrides: Partial<IngestCoupon> = {},
): IngestCoupon {
    return {
        id,
        code: `CODE${id}`,
        site: 'kikoff.com',
        title: `t-${id}`,
        description: 'd',
        rating: 0,
        discount_type: null,
        discount_amount: null,
        expiry: null,
        expired: false,
        times_used: 0,
        last_time_used: null,
        status: 'pending',
        verification_message: null,
        updated_at: PUSH_AT,
        ...overrides,
    }
}

function stored(id: string, overrides: Partial<StoredRow> = {}): StoredRow {
    return {
        id,
        site: 'kikoff.com',
        code: `CODE${id}`,
        expired: false,
        status: 'pending',
        updated_at: STORED_AT,
        new_customers_only: null,
        ...overrides,
    }
}

const REFERRAL = {
    title: 'Kikoff Referral Code',
    description: '$10 statement credit for new members',
}

function insertSql(): Captured | undefined {
    return captured.find(c => c.sql.includes('INSERT INTO coupons'))
}

function written(): Array<{
    id: unknown
    expired: unknown
    newCustomersOnly: unknown
}> {
    const insert = insertSql()
    if (!insert) return []
    const out = []
    for (let i = 0; i < insert.values.length; i += TUPLE_WIDTH) {
        out.push({
            id: insert.values[i + ID_AT],
            expired: insert.values[i + EXPIRED_AT],
            newCustomersOnly: insert.values[i + NEW_CUSTOMERS_ONLY_AT],
        })
    }
    return out
}

function push(coupons: IngestCoupon[]) {
    return applyCatalogRows({
        coupons,
        storeConfigs: [],
        sources: [],
        force: false,
    })
}

let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    captured.length = 0
    state.stored = []
    state.visibleCount = 100
    txMock.$queryRaw.mockClear()
    txMock.$executeRaw.mockClear()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    info.mockRestore()
})

describe('ingest schema - new_customers_only is optional on the wire', () => {
    const base = {
        id: '52259',
        code: 'PTSCS7AI',
        site: 'kikoff.com',
        title: 't',
        description: 'd',
        discount_type: null,
        discount_amount: null,
        expiry: null,
        status: 'pending',
        verification_message: null,
        updated_at: '2026-10-19T10:00:00Z',
    }

    it('accepts a row without it (every producer today), leaving it undefined', () => {
        const parsed = IngestCatalogPayloadSchema.parse({ coupons: [base] })
        expect(parsed.coupons[0]?.new_customers_only).toBeUndefined()
    })

    it('accepts true, false and null', () => {
        for (const value of [true, false, null]) {
            const parsed = IngestCatalogPayloadSchema.parse({
                coupons: [{ ...base, new_customers_only: value }],
            })
            expect(parsed.coupons[0]?.new_customers_only).toBe(value)
        }
    })

    it('rejects a non-boolean value', () => {
        expect(() =>
            IngestCatalogPayloadSchema.parse({
                coupons: [{ ...base, new_customers_only: 'yes' }],
            }),
        ).toThrow()
    })
})

describe('applyCatalogRows - new_customers_only is never clobbered by a push that omits it', () => {
    it('writes a pushed true, and the ON CONFLICT keeps the stored value when the push has none', async () => {
        const result = await push([
            coupon('1', { new_customers_only: true }),
            coupon('2'),
        ])

        expect(result.coupons.inserted).toBe(2)
        expect(written()).toEqual([
            { id: '1', expired: false, newCustomersOnly: true },
            { id: '2', expired: false, newCustomersOnly: null },
        ])
        const sql = insertSql()?.sql ?? ''
        expect(sql).toContain('new_customers_only')
        expect(sql).toMatch(
            /new_customers_only\s*=\s*COALESCE\(excluded\.new_customers_only,\s*coupons\.new_customers_only\)/,
        )
    })

    it('passes an explicit false through, so a producer can clear the flag', async () => {
        state.stored = [stored('3', { new_customers_only: true })]

        await push([coupon('3', { new_customers_only: false })])

        expect(written()).toEqual([
            { id: '3', expired: false, newCustomersOnly: false },
        ])
    })
})

describe('applyCatalogRows - a flagged referral code is a kept new-customer offer', () => {
    it('inserts a referral-worded row the producer flags new_customers_only', async () => {
        const result = await push([
            coupon('10', { ...REFERRAL, new_customers_only: true }),
        ])

        expect(result.coupons.skippedReferral).toBe(0)
        expect(result.coupons.inserted).toBe(1)
        expect(written()).toEqual([
            { id: '10', expired: false, newCustomersOnly: true },
        ])
    })

    it('does not expire a stored flagged row when the push omits the flag', async () => {
        state.stored = [stored('11', { new_customers_only: true })]

        const result = await push([coupon('11', REFERRAL)])

        expect(result.coupons.updated).toBe(1)
        expect(result.coupons.tombstoned).toBe(0)
        expect(written()).toEqual([
            { id: '11', expired: false, newCustomersOnly: null },
        ])
    })

    it('still removes an unflagged referral row (the T-2956 filter is unchanged)', async () => {
        state.stored = [stored('12')]

        const result = await push([coupon('12', REFERRAL)])

        expect(result.coupons.tombstoned).toBe(1)
        expect(written()).toEqual([
            { id: '12', expired: true, newCustomersOnly: null },
        ])
    })

    it('removes a stored flagged referral row when the push explicitly clears the flag', async () => {
        state.stored = [stored('13', { new_customers_only: true })]

        await push([coupon('13', { ...REFERRAL, new_customers_only: false })])

        expect(written()).toEqual([
            { id: '13', expired: true, newCustomersOnly: false },
        ])
    })
})
