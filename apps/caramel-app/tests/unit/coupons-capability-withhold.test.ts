import { GET } from '@/app/api/coupons/route'
import {
    CAPABILITY_PROOF_PARAM,
    parseCapabilityProof,
} from '@/lib/extensionCapabilityGates'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Builds 1.4.13/1.4.14 are already installed with a generic promo-box finder
// that needs no store config: on porkbun.com they fetch codes by domain and
// drive the checkout, and every refused code raises Porkbun's native alert().
// GET /api/coupons is their only path to those codes, so it withholds a gated
// store's codes from an EXTENSION request that does not prove the capability
// (`?caps=alertShim`). The website (no extension Origin) keeps the full list.
// See src/lib/extensionCapabilityGates.ts.

const { listCouponsMock } = vi.hoisted(() => ({ listCouponsMock: vi.fn() }))
vi.mock('@/lib/couponsRepo', () => ({ listCoupons: listCouponsMock }))
vi.mock('@/lib/couponSignals', () => ({
    attachSignals: async (coupons: unknown[]) => coupons,
}))
vi.mock('@/lib/rateLimit', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/rateLimit')>()),
    checkRateLimit: async () => null,
}))

const CODES = [{ id: '1', code: 'PORK10' }]

const EXTENSION_ORIGINS = [
    'chrome-extension://abcdefghijklmnop',
    'moz-extension://11111111-2222-3333-4444-555555555555',
    'safari-web-extension://AAAA-BBBB',
]

function get(query: string, origin?: string) {
    return GET(
        new NextRequest(`http://localhost/api/coupons?${query}`, {
            headers: origin ? { origin } : {},
        }),
    )
}

beforeEach(() => {
    listCouponsMock.mockReset()
    listCouponsMock.mockResolvedValue({ coupons: CODES, total: 1 })
})

describe('GET /api/coupons — gated store (porkbun.com)', () => {
    it.each(EXTENSION_ORIGINS)(
        'withholds the codes from an extension that sends no proof (%s)',
        async origin => {
            const res = await get('site=porkbun.com&limit=20', origin)
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({
                coupons: [],
                page: 1,
                limit: 20,
                total: 0,
                hasMore: false,
            })
            expect(res.headers.get('X-Caramel-Capability-Withheld')).toBe(
                'alertShim',
            )
            expect(listCouponsMock).not.toHaveBeenCalled()
        },
    )

    it('withholds from www.porkbun.com too (the site is normalised first)', async () => {
        const res = await get(
            'site=www.porkbun.com',
            'chrome-extension://abcdefghijklmnop',
        )
        expect((await res.json()).coupons).toEqual([])
    })

    it.each([
        'PORKBUN.COM',
        'checkout.porkbun.com',
        'porkbun.com.',
        'https://www.porkbun.com/checkout/cart',
        'porkbun.com:443',
    ])('withholds however the site is spelled (%s)', async site => {
        const res = await get(
            `site=${encodeURIComponent(site)}`,
            'chrome-extension://abcdefghijklmnop',
        )
        expect(res.status).toBe(200)
        expect((await res.json()).coupons).toEqual([])
        expect(listCouponsMock).not.toHaveBeenCalled()
    })

    it('treats Origin: null as no extension (the website sandbox case), not as one', async () => {
        const res = await get('site=porkbun.com', 'null')
        expect((await res.json()).coupons).toEqual(CODES)
    })

    it('a repeated caps param reads the first one', async () => {
        const res = await get(
            'site=porkbun.com&caps=nope&caps=alertShim',
            'chrome-extension://abcdefghijklmnop',
        )
        expect((await res.json()).coupons).toEqual([])
    })

    it('withholds when the proof names a capability the server does not know', async () => {
        const res = await get(
            `site=porkbun.com&${CAPABILITY_PROOF_PARAM}=somethingNew,%20,`,
            'chrome-extension://abcdefghijklmnop',
        )
        expect((await res.json()).coupons).toEqual([])
    })

    it.each(EXTENSION_ORIGINS)(
        'serves the codes to an extension that proves alertShim (%s)',
        async origin => {
            const res = await get(
                `site=porkbun.com&${CAPABILITY_PROOF_PARAM}=alertShim`,
                origin,
            )
            expect((await res.json()).coupons).toEqual(CODES)
            expect(res.headers.get('X-Caramel-Capability-Withheld')).toBeNull()
        },
    )

    it('keeps the full list for the website (no extension Origin)', async () => {
        for (const origin of [undefined, 'https://grabcaramel.com']) {
            const res = await get('site=porkbun.com', origin)
            expect((await res.json()).coupons).toEqual(CODES)
        }
    })

    it('never lets a shared cache keep an answer that depends on who asked', async () => {
        const withheld = await get(
            'site=porkbun.com',
            'chrome-extension://abcdefghijklmnop',
        )
        const proven = await get(
            'site=porkbun.com&caps=alertShim',
            'chrome-extension://abcdefghijklmnop',
        )
        const website = await get('site=porkbun.com')
        for (const res of [withheld, proven, website]) {
            expect(res.headers.get('Cache-Control')).toBe('private, no-store')
        }
    })
})

describe('GET /api/coupons — every other store is unaffected', () => {
    it('serves an extension request with no proof, and keeps the edge cache', async () => {
        const res = await get(
            'site=example.com',
            'chrome-extension://abcdefghijklmnop',
        )
        expect((await res.json()).coupons).toEqual(CODES)
        expect(res.headers.get('Cache-Control')).toBe(
            'public, s-maxage=60, stale-while-revalidate=60',
        )
        expect(res.headers.get('X-Caramel-Capability-Withheld')).toBeNull()
    })

    it('serves a request with no site at all', async () => {
        const res = await get('', 'chrome-extension://abcdefghijklmnop')
        expect((await res.json()).coupons).toEqual(CODES)
    })

    it('does not treat a look-alike host as porkbun.com', async () => {
        const res = await get(
            'site=notporkbun.com',
            'chrome-extension://abcdefghijklmnop',
        )
        expect((await res.json()).coupons).toEqual(CODES)
    })
})

describe('parseCapabilityProof', () => {
    it('reads a comma list and keeps only capabilities this server knows', () => {
        expect(Array.from(parseCapabilityProof('alertShim'))).toEqual([
            'alertShim',
        ])
        expect(Array.from(parseCapabilityProof(' alertShim , nope '))).toEqual([
            'alertShim',
        ])
        expect(Array.from(parseCapabilityProof('ALERTSHIM'))).toEqual([])
        expect(Array.from(parseCapabilityProof(''))).toEqual([])
        expect(Array.from(parseCapabilityProof(null))).toEqual([])
    })
})
