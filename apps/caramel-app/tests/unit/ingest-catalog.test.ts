import { POST } from '@/app/api/ingest/catalog/route'
import { applyCatalogRows } from '@/lib/catalog/applyCatalogRows'
import { IngestCatalogPayloadSchema } from '@/lib/catalog/ingestSchemas'
import { isIngestAuthorized } from '@/lib/rateLimit'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit coverage for POST /api/ingest/catalog (W3b) — the HTTP contract the route
// adds on top of applyCatalogRows: the apiKey:'ingest' bearer gate
// (INGEST_API_KEY, fail-closed when unset), zod body rejection, and the 409
// tombstone-gate mapping. applyCatalogRows is MOCKED here so no DB is touched;
// its real behaviour (only-if-newer, the gate, transaction atomicity) is covered
// against live postgres in tests/integration/ingest-catalog.itest.ts.

const { envMock } = vi.hoisted(() => ({
    envMock: { INGEST_API_KEY: undefined as string | undefined },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/catalog/applyCatalogRows', () => ({
    applyCatalogRows: vi.fn(),
}))

const INGEST_KEY = 'test-ingest-key-W3b'

// A fully-populated coupon satisfying IngestCouponSchema — nullable columns
// require the key present (the ingest contract is "send every column"), so a
// minimal valid row still carries the explicit nulls.
const VALID_COUPON = {
    id: '800000001',
    code: 'SAVE10',
    site: 'ebay.com',
    title: 'Ten off',
    description: 'Ten dollars off',
    discount_type: null,
    discount_amount: null,
    expiry: null,
    verification_message: null,
    status: 'valid',
    updated_at: '2026-07-14T00:00:00.000Z',
}

const NON_GATED = {
    gated: false as const,
    coupons: { inserted: 1, updated: 0, skippedOlder: 0, tombstoned: 0 },
    storeConfigs: { upserted: 0 },
    sources: { upserted: 0 },
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/ingest/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

function authed(body: unknown, extra: Record<string, string> = {}) {
    return makeRequest(body, {
        authorization: `Bearer ${INGEST_KEY}`,
        ...extra,
    })
}

beforeEach(() => {
    envMock.INGEST_API_KEY = INGEST_KEY
    vi.mocked(applyCatalogRows).mockReset()
    vi.mocked(applyCatalogRows).mockResolvedValue(NON_GATED)
})

describe('POST /api/ingest/catalog — auth (apiKey:ingest bearer)', () => {
    it('no Authorization header → 401, applyCatalogRows not called', async () => {
        const res = await POST(makeRequest({ coupons: [VALID_COUPON] }))
        expect(res.status).toBe(401)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('wrong bearer → 401', async () => {
        const res = await POST(
            makeRequest(
                { coupons: [VALID_COUPON] },
                { authorization: 'Bearer nope' },
            ),
        )
        expect(res.status).toBe(401)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('INGEST_API_KEY unset server-side → 401 even with a bearer (fail-closed)', async () => {
        envMock.INGEST_API_KEY = undefined
        const res = await POST(authed({ coupons: [VALID_COUPON] }))
        expect(res.status).toBe(401)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('valid bearer + valid body → 200 { ok, applied }', async () => {
        const res = await POST(authed({ coupons: [VALID_COUPON] }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, applied: NON_GATED })
        expect(applyCatalogRows).toHaveBeenCalledOnce()
    })
})

describe('POST /api/ingest/catalog — body validation + gate mapping', () => {
    it('coupon missing updated_at → 422, applyCatalogRows not called', async () => {
        const { updated_at: _omit, ...noTimestamp } = VALID_COUPON
        const res = await POST(authed({ coupons: [noTimestamp] }))
        expect(res.status).toBe(422)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('empty payload (no rows at all) → 422 (refine), applyCatalogRows not called', async () => {
        const res = await POST(
            authed({ coupons: [], storeConfigs: [], sources: [] }),
        )
        expect(res.status).toBe(422)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('non-numeric coupon id → 422', async () => {
        const res = await POST(
            authed({ coupons: [{ ...VALID_COUPON, id: 'abc' }] }),
        )
        expect(res.status).toBe(422)
    })

    it('gated push → 409 with the gate detail + a force hint', async () => {
        const gate = { wouldTombstone: 8, visibleBefore: 30, thresholdPct: 20 }
        vi.mocked(applyCatalogRows).mockResolvedValue({
            gated: true,
            gate,
            coupons: {
                inserted: 0,
                updated: 0,
                skippedOlder: 0,
                tombstoned: 0,
            },
            storeConfigs: { upserted: 0 },
            sources: { upserted: 0 },
        })
        const res = await POST(authed({ coupons: [VALID_COUPON] }))
        expect(res.status).toBe(409)
        const json = await res.json()
        expect(json.gate).toEqual(gate)
        expect(json.error).toContain('force:true')
    })
})

describe('POST /api/ingest/catalog — reserved shopper id range', () => {
    // Ids from 900000000000000000 up come from shopper_coupon_id_seq
    // (submitShopperCoupon). A supplier row in that range could overwrite a
    // shopper's row under the only-if-newer upsert, so the schema refuses it.
    it('id at the floor (900000000000000000) → 422 naming the reserved range, applyCatalogRows not called', async () => {
        const res = await POST(
            authed({
                coupons: [{ ...VALID_COUPON, id: '900000000000000000' }],
            }),
        )
        expect(res.status).toBe(422)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('the schema names the reserved range in its issue (the route hides issue text from the client)', () => {
        const parsed = IngestCatalogPayloadSchema.safeParse({
            coupons: [{ ...VALID_COUPON, id: '900000000000000000' }],
        })
        expect(parsed.success).toBe(false)
        expect(JSON.stringify(parsed.error?.issues)).toContain(
            'reserved shopper range',
        )
        expect(
            IngestCatalogPayloadSchema.safeParse({
                coupons: [{ ...VALID_COUPON, id: '899999999999999999' }],
            }).success,
        ).toBe(true)
    })

    it('numeric id above the floor → 422 as well (the union accepts numbers)', async () => {
        const res = await POST(
            authed({ coupons: [{ ...VALID_COUPON, id: 950000000000000000 }] }),
        )
        expect(res.status).toBe(422)
        expect(applyCatalogRows).not.toHaveBeenCalled()
    })

    it('id just below the floor (899999999999999999) → accepted', async () => {
        const res = await POST(
            authed({
                coupons: [{ ...VALID_COUPON, id: '899999999999999999' }],
            }),
        )
        expect(res.status).toBe(200)
        expect(applyCatalogRows).toHaveBeenCalledOnce()
    })
})

describe('isIngestAuthorized (constant-time bearer, fail-closed)', () => {
    function req(headers: Record<string, string> = {}) {
        return new NextRequest('http://localhost/api/ingest/catalog', {
            method: 'POST',
            headers,
        })
    }
    it('unset key → false even with a bearer', () => {
        envMock.INGEST_API_KEY = undefined
        expect(
            isIngestAuthorized(req({ authorization: `Bearer ${INGEST_KEY}` })),
        ).toBe(false)
    })
    it('correct bearer → true', () => {
        expect(
            isIngestAuthorized(req({ authorization: `Bearer ${INGEST_KEY}` })),
        ).toBe(true)
    })
    it('missing / wrong / unprefixed header → false', () => {
        expect(isIngestAuthorized(req())).toBe(false)
        expect(isIngestAuthorized(req({ authorization: 'Bearer wrong' }))).toBe(
            false,
        )
        expect(isIngestAuthorized(req({ authorization: INGEST_KEY }))).toBe(
            false,
        )
    })
})
