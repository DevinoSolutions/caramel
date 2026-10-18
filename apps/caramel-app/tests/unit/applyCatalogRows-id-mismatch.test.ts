import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the id-identity guard in applyCatalogRows (T-2956 follow-up). The
// catalog's ids come from two id spaces: the 2026-08-08 bridge-sync seeded the
// app from the dev coupons DB, and the prod pipeline DB (rebuilt 2026-08-10/11)
// re-minted ids from 74351 on. On prod 2026-10-18, 8,824 app ids still hold a
// different coupon than the pipeline row with the same id (vitabiotics.com
// GPN10 at id 103346, where the pipeline has unbounce.com JhonDodo88), and
// 20,339 dev-seeded rows had already been overwritten that way. A pushed row is
// therefore applied to a stored row ONLY when both are the same coupon: same
// site (lowercased, like normalizeSite) and same code (case-insensitive, like
// submitShopperCoupon's lower(code) dedupe). Anything else is counted
// `skippedIdMismatch`, logged, and never written. Same mocking pattern as
// applyCatalogRows-referral.test.ts.

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

const TUPLE_WIDTH = 16
const ID_AT = 0
const CODE_AT = 1
const SITE_AT = 2
const EXPIRED_AT = 9

const PUSH_AT = new Date('2026-10-18T10:05:30.000Z')
const STORED_AT = new Date('2026-08-03T02:33:07.000Z')

function coupon(
    id: string,
    site: string | null,
    code: string,
    overrides: Partial<IngestCoupon> = {},
): IngestCoupon {
    return {
        id,
        code,
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
        updated_at: PUSH_AT,
        ...overrides,
    }
}

function stored(
    id: string,
    site: string | null,
    code: string,
    overrides: Partial<StoredRow> = {},
): StoredRow {
    return {
        id,
        site,
        code,
        expired: false,
        status: 'pending',
        updated_at: STORED_AT,
        ...overrides,
    }
}

function writtenCoupons(): Array<{
    id: unknown
    code: unknown
    site: unknown
    expired: unknown
}> {
    const insert = captured.find(c => c.sql.includes('INSERT INTO coupons'))
    if (!insert) return []
    const out: Array<{
        id: unknown
        code: unknown
        site: unknown
        expired: unknown
    }> = []
    for (let i = 0; i < insert.values.length; i += TUPLE_WIDTH) {
        out.push({
            id: insert.values[i + ID_AT],
            code: insert.values[i + CODE_AT],
            site: insert.values[i + SITE_AT],
            expired: insert.values[i + EXPIRED_AT],
        })
    }
    return out
}

function push(coupons: IngestCoupon[], force = false) {
    return applyCatalogRows({ coupons, storeConfigs: [], sources: [], force })
}

let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    captured.length = 0
    state.stored = []
    state.visibleCount = 0
    txMock.$queryRaw.mockClear()
    txMock.$executeRaw.mockClear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    warn.mockRestore()
    info.mockRestore()
})

describe('applyCatalogRows - a pushed id that holds a different coupon is never overwritten', () => {
    it('skips a row whose stored site and code both differ (prod: vitabiotics GPN10 at 103346)', async () => {
        state.stored = [stored('103346', 'vitabiotics.com', 'GPN10')]
        state.visibleCount = 100

        const result = await push([
            coupon('103346', 'unbounce.com', 'JhonDodo88', {
                status: 'invalid',
            }),
        ])

        expect(result.gated).toBe(false)
        expect(result.coupons).toEqual({
            inserted: 0,
            updated: 0,
            skippedOlder: 0,
            tombstoned: 0,
            skippedReferral: 0,
            skippedIdMismatch: 1,
        })
        expect(captured).toHaveLength(0)
    })

    it('skips a row whose code differs on the same site', async () => {
        state.stored = [stored('87959', 'petdrugsonline.co.uk', 'NALA20')]

        const result = await push([
            coupon('87959', 'petdrugsonline.co.uk', 'PURINAEXTRA10'),
        ])

        expect(result.coupons.skippedIdMismatch).toBe(1)
        expect(result.coupons.updated).toBe(0)
        expect(captured).toHaveLength(0)
    })

    it('skips a row whose site differs for the same code', async () => {
        state.stored = [stored('93793', 'skylightframe.com', 'CYBER24')]

        const result = await push([coupon('93793', 'rover.com', 'CYBER24')])

        expect(result.coupons.skippedIdMismatch).toBe(1)
        expect(captured).toHaveLength(0)
    })

    it('never expires the stored real coupon when the pushed row is a referral code', async () => {
        state.stored = [stored('103346', 'vitabiotics.com', 'GPN10')]
        state.visibleCount = 100

        const result = await push([
            coupon('103346', 'unbounce.com', 'JhonDodo88', {
                title: 'Unbounce Referral Code',
                description: 'Refer a friend and get 20% off',
            }),
        ])

        expect(result.coupons).toEqual({
            inserted: 0,
            updated: 0,
            skippedOlder: 0,
            tombstoned: 0,
            skippedReferral: 0,
            skippedIdMismatch: 1,
        })
        expect(captured).toHaveLength(0)
    })

    it('counts a mismatch even when the stored row is newer', async () => {
        state.stored = [
            stored('86834', 'nobodyschild.com', 'MEMBER15', {
                updated_at: new Date('2026-12-01T00:00:00.000Z'),
            }),
        ]

        const result = await push([
            coupon('86834', 'dish.com', 'VCD0024956544'),
        ])

        expect(result.coupons.skippedIdMismatch).toBe(1)
        expect(result.coupons.skippedOlder).toBe(0)
        expect(captured).toHaveLength(0)
    })

    it('still updates the same coupon when only the letter case of site or code differs', async () => {
        state.stored = [
            stored('500', 'example.com', 'save10'),
            stored('501', 'example.com', 'SAVE20'),
        ]
        state.visibleCount = 100

        const result = await push([
            coupon('500', 'Example.COM', 'SAVE10', { status: 'invalid' }),
            coupon('501', 'example.com', 'save20'),
        ])

        expect(result.coupons.updated).toBe(2)
        expect(result.coupons.skippedIdMismatch).toBe(0)
        expect(result.coupons.tombstoned).toBe(1)
        expect(writtenCoupons()).toEqual([
            {
                id: '500',
                code: 'SAVE10',
                site: 'example.com',
                expired: false,
            },
            {
                id: '501',
                code: 'save20',
                site: 'example.com',
                expired: false,
            },
        ])
    })

    it('treats a null stored site and a null pushed site as the same site', async () => {
        state.stored = [stored('600', null, 'NOSITE')]

        const result = await push([coupon('600', null, 'NOSITE')])

        expect(result.coupons.updated).toBe(1)
        expect(result.coupons.skippedIdMismatch).toBe(0)
    })

    it('skips a null site pushed over a stored site', async () => {
        state.stored = [stored('601', 'example.com', 'CODE601')]

        const result = await push([coupon('601', null, 'CODE601')])

        expect(result.coupons.skippedIdMismatch).toBe(1)
        expect(captured).toHaveLength(0)
    })

    it('writes the matching rows of a mixed push and leaves the mismatched ones alone', async () => {
        state.stored = [
            stored('103346', 'vitabiotics.com', 'GPN10'),
            stored('700', 'example.com', 'KEEP'),
        ]
        state.visibleCount = 100

        const result = await push([
            coupon('103346', 'unbounce.com', 'JhonDodo88'),
            coupon('700', 'example.com', 'KEEP'),
            coupon('701', 'example.com', 'NEW'),
        ])

        expect(result.coupons).toEqual({
            inserted: 1,
            updated: 1,
            skippedOlder: 0,
            tombstoned: 0,
            skippedReferral: 0,
            skippedIdMismatch: 1,
        })
        expect(writtenCoupons().map(w => w.id)).toEqual(['700', '701'])
    })

    it('does not count skipped mismatches toward the 20% gate', async () => {
        state.stored = [
            stored('801', 'a.com', 'A1'),
            stored('802', 'b.com', 'B1'),
            stored('803', 'c.com', 'C1'),
        ]
        state.visibleCount = 10

        const result = await push([
            coupon('801', 'x.com', 'X1', { expired: true }),
            coupon('802', 'y.com', 'Y1', { expired: true }),
            coupon('803', 'z.com', 'Z1', { expired: true }),
        ])

        expect(result.gated).toBe(false)
        expect(result.coupons.tombstoned).toBe(0)
        expect(result.coupons.skippedIdMismatch).toBe(3)
    })

    it('keeps the 20% gate for real tombstones', async () => {
        state.stored = [
            stored('811', 'a.com', 'A1'),
            stored('812', 'b.com', 'B1'),
            stored('813', 'c.com', 'C1'),
        ]
        state.visibleCount = 10

        const result = await push([
            coupon('811', 'a.com', 'A1', { expired: true }),
            coupon('812', 'b.com', 'B1', { expired: true }),
            coupon('813', 'c.com', 'C1', { expired: true }),
        ])

        expect(result.gated).toBe(true)
        expect(result.gate?.wouldTombstone).toBe(3)
        expect(captured).toHaveLength(0)
    })

    it('reads site and code in the current-state snapshot', async () => {
        await push([coupon('900', 'example.com', 'X')])

        const calls = txMock.$queryRaw.mock.calls as unknown as Captured[][]
        const select = calls[0]?.[0]
        expect(select?.sql).toMatch(
            /SELECT id, site, code, expired, status, updated_at FROM coupons/,
        )
    })

    it('guards the upsert itself, so a concurrent write cannot slip a different coupon onto the id', async () => {
        await push([coupon('901', 'example.com', 'X')])

        const insert = captured.find(c => c.sql.includes('INSERT INTO coupons'))
        expect(insert?.sql).toContain(
            'lower(coupons.site) IS NOT DISTINCT FROM excluded.site',
        )
        expect(insert?.sql).toContain(
            'lower(coupons.code) = lower(excluded.code)',
        )
    })

    it('logs the mismatch count with the ids, never the codes', async () => {
        state.stored = [
            stored('103346', 'vitabiotics.com', 'GPN10'),
            stored('103347', 'vitabiotics.com', '204ME'),
        ]

        await push([
            coupon('103346', 'unbounce.com', 'JhonDodo88'),
            coupon('103347', 'unbounce.com', 'CharlotteDavies55'),
        ])

        expect(warn).toHaveBeenCalledTimes(1)
        const line = String(warn.mock.calls[0]?.[0])
        expect(line).toContain('[ingest/catalog]')
        expect(line).toContain('skippedIdMismatch=2')
        expect(line).toContain('103346')
        expect(line).toContain('103347')
        expect(line).not.toContain('GPN10')
        expect(line).not.toContain('JhonDodo88')
    })

    it('does not warn when nothing mismatched', async () => {
        await push([coupon('902', 'example.com', 'X')])

        expect(warn).not.toHaveBeenCalled()
    })

    it('logs one summary line per push that carries the mismatch counter', async () => {
        state.stored = [stored('103346', 'vitabiotics.com', 'GPN10')]

        await push([
            coupon('103346', 'unbounce.com', 'JhonDodo88'),
            coupon('903', 'example.com', 'X'),
        ])

        expect(info).toHaveBeenCalledTimes(1)
        const line = String(info.mock.calls[0]?.[0])
        expect(line).toContain('[ingest/catalog]')
        expect(line).toContain('inserted=1')
        expect(line).toContain('skippedIdMismatch=1')
    })
})
