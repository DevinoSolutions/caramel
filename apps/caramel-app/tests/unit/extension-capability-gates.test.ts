import { GET } from '@/app/api/extension/supported-stores/route'
import {
    EXTENSION_CAPABILITIES,
    EXTENSION_CAPABILITY_GATES,
    requiredCapabilityFor,
} from '@/lib/extensionCapabilityGates'
import { resetSupportedStoresCache } from '@/lib/supportedStoresCache'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// porkbun.com refuses a coupon with a native alert(), twice per scripted
// attempt. Builds that predate the page-side helper (porkbun-alert-shim.js)
// must never receive its apply config, and the payload is one shared body
// (in-process + Cloudflare cache), so the gate is a payload SPLIT, not a
// per-request answer. See src/lib/extensionCapabilityGates.ts.

const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => null) }))

const row = (store_name: string) => ({
    store_name,
    show_input_xpath: '[data-target="#modal_applyCouponCode"]',
    dismiss_button_xpath: null,
    coupon_input_xpath: '#cartCouponCode',
    apply_button_xpath: '#modal_applyCouponCode .btn-porkbun',
    price_container_xpath: '#cartTotalDisplay',
    success_indicator_xpath: null,
    error_indicator_xpath: '#caramel-porkbun-coupon-rejection',
    coupon_remove_xpath: null,
})

interface Payload {
    supported: { domain: string }[]
    gated: { domain: string; requires: string }[]
}

async function payload(): Promise<Payload> {
    const res = await GET(
        new NextRequest('http://localhost/api/extension/supported-stores'),
    )
    return (await res.json()) as Payload
}

beforeEach(() => {
    resetSupportedStoresCache()
    queryRawMock.mockReset()
})

describe('requiredCapabilityFor', () => {
    it('gates porkbun.com, with or without www and in any case', () => {
        expect(requiredCapabilityFor('porkbun.com')).toBe('alertShim')
        expect(requiredCapabilityFor('www.porkbun.com')).toBe('alertShim')
        expect(requiredCapabilityFor('PorkBun.com')).toBe('alertShim')
    })

    it('does not gate other stores, nor look-alike hosts', () => {
        expect(requiredCapabilityFor('example.com')).toBeNull()
        expect(requiredCapabilityFor('notporkbun.com')).toBeNull()
        expect(requiredCapabilityFor('porkbun.com.evil.example')).toBeNull()
    })
})

describe('GET /api/extension/supported-stores: capability split', () => {
    it('keeps a gated store out of `supported` and serves it in `gated`', async () => {
        queryRawMock.mockResolvedValue([row('example.com'), row('porkbun.com')])
        const body = await payload()

        expect(body.supported.map(e => e.domain)).toEqual(['example.com'])
        expect(body.gated).toEqual([
            expect.objectContaining({
                domain: 'porkbun.com',
                couponInput: '#cartCouponCode',
                couponSubmit: '#modal_applyCouponCode .btn-porkbun',
                priceContainer: '#cartTotalDisplay',
                showInput: '[data-target="#modal_applyCouponCode"]',
                errorIndicator: '#caramel-porkbun-coupon-rejection',
                requires: 'alertShim',
            }),
        ])
    })

    it('an old extension reading only `supported` never sees the gated store', async () => {
        queryRawMock.mockResolvedValue([row('porkbun.com')])
        const body = await payload()
        expect(body.supported).toEqual([])
    })

    it('ungated rows carry no `requires` key (the legacy shape is unchanged)', async () => {
        queryRawMock.mockResolvedValue([row('example.com')])
        const body = await payload()
        expect(Object.keys(body.supported[0] as object)).not.toContain(
            'requires',
        )
    })
})

describe('app <-> extension capability contract', () => {
    const source = fs.readFileSync(
        path.resolve(
            __dirname,
            '../../../caramel-extension/extension-capabilities.js',
        ),
        'utf8',
    )
    // The keys of CARAMEL_CAPABILITY_MARKERS in the extension module.
    const markerTable = /Object\.freeze\(\{([^}]*)\}\)/.exec(source)?.[1] ?? ''
    const extensionCapabilities = Array.from(
        markerTable.matchAll(/(\w+)\s*:\s*'data-caramel-[a-z-]+'/g),
        m => m[1] as string,
    )

    // The extension's own host -> capability table (CARAMEL_HOST_CAPABILITY_REQUIREMENTS).
    const hostTable =
        /CARAMEL_HOST_CAPABILITY_REQUIREMENTS = Object\.freeze\(\{([^}]*)\}\)/.exec(
            source,
        )?.[1] ?? ''
    const extensionHostRequirements = Object.fromEntries(
        Array.from(hostTable.matchAll(/'([^']+)'\s*:\s*'(\w+)'/g), m => [
            m[1] as string,
            m[2] as string,
        ]),
    )

    it('every capability the server can require is one the extension knows', () => {
        expect(extensionCapabilities.length).toBeGreaterThan(0)
        for (const capability of Object.values(EXTENSION_CAPABILITY_GATES)) {
            expect(extensionCapabilities).toContain(capability)
        }
    })

    it('the server lists exactly the capabilities the extension defines', () => {
        expect([...EXTENSION_CAPABILITIES].sort()).toEqual(
            [...extensionCapabilities].sort(),
        )
    })

    it('the extension withholds exactly the stores the server gates', () => {
        expect(Object.keys(extensionHostRequirements).length).toBeGreaterThan(0)
        expect(extensionHostRequirements).toEqual({
            ...EXTENSION_CAPABILITY_GATES,
        })
    })
})
