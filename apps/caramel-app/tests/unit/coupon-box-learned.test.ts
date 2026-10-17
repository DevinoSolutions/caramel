import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-learned + couponBoxLearned.ts's validation
// and hashing: everything that must be refused BEFORE a report touches the
// database. The counting and serving rules run on real Postgres in
// tests/integration/coupon-box-learned.itest.ts.

// MOCK (announced): the two database calls the route makes. What they are
// asked, and whether they are asked at all, is what these tests measure.
const { envMock, recordMock, servedMock, suggestMock } = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
    recordMock: vi.fn(
        async (
            _input: unknown,
        ): Promise<
            | { recorded: true; counted: boolean; servable: boolean }
            | { recorded: false; reason: 'unknown_box' | 'ignored' }
        > => ({ recorded: true, counted: true, servable: false }),
    ),
    servedMock: vi.fn(async (_host: string) => false),
    suggestMock: vi.fn(
        async (_host: string): Promise<{ created: boolean }> => ({
            created: true,
        }),
    ),
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/couponBoxLearned', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/couponBoxLearned')>()),
    recordLearnedBoxReport: recordMock,
    handOverLearnedStore: suggestMock,
}))
vi.mock('@/lib/couponsRepo', () => ({ hasServedStoreConfig: servedMock }))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { POST } from '@/app/api/extension/coupon-box-learned/route'
import {
    hashInstallId,
    hashNetwork,
    hashNetworkAcrossStores,
    learnedBoxReportSchema,
    learnedStoreDomain,
    networkPrefix,
} from '@/lib/couponBoxLearned'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const INSTALL_ID = '3f0c6a52-6a1e-4b8e-9d1f-2b7c1e0a9f44'

const goodReport = (overrides: Record<string, unknown> = {}) => ({
    installId: INSTALL_ID,
    domain: 'shop-example.com',
    box: {
        input: '#promo',
        apply: 'button[name="apply"]',
        toggle: null,
        enterOnly: false,
    },
    source: 'rules',
    evidence: 'total_dropped',
    outcome: 'confirmed',
    ...overrides,
})

function post(
    body: unknown,
    {
        origin = EXT_ORIGIN,
        ip = '203.0.113.5',
        headers = {},
    }: {
        origin?: string | null
        ip?: string
        headers?: Record<string, string>
    } = {},
) {
    const h: Record<string, string> = {
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
        ...headers,
    }
    if (origin) h.origin = origin
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-learned', {
            method: 'POST',
            headers: h,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    envMock.COUPON_BOX_LEARNED_ENABLED = true
    envMock.COUPON_BOX_LEARNED_SALT = 'unit-salt-unit-salt-unit-salt-unit-salt'
    recordMock.mockClear()
    servedMock.mockReset()
    servedMock.mockImplementation(async () => false)
    suggestMock.mockClear()
})

describe('POST /api/extension/coupon-box-learned', () => {
    it('records a valid report with the salted hashes, never the raw install id or IP', async () => {
        const res = await post(goodReport())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ recorded: true })
        expect(recordMock).toHaveBeenCalledTimes(1)
        const call = recordMock.mock.calls[0]?.[0] as {
            installHash: string
            networkHash: string
            anyStoreNetworkHash: string
        }
        expect(call.installHash).toBe(
            hashInstallId(INSTALL_ID, 'shop-example.com'),
        )
        expect(call.installHash).toMatch(/^[0-9a-f]{64}$/)
        expect(call.installHash).not.toContain(INSTALL_ID)
        expect(call.networkHash).toBe(
            hashNetwork('203.0.113.99', 'shop-example.com'),
        )
        expect(call.anyStoreNetworkHash).toBe(
            hashNetworkAcrossStores('203.0.113.99'),
        )
    })

    it('forged origin: a non-extension Origin is refused (403) and records nothing', async () => {
        for (const origin of ['https://evil.example', null]) {
            const res = await post(goodReport(), { origin })
            expect(res.status).toBe(403)
        }
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('oversize body: 413 by Content-Length and by the bytes that arrived', async () => {
        const big = goodReport({ pad: 'x'.repeat(5000) })
        const declared = await post(goodReport(), {
            headers: { 'content-length': '999999' },
        })
        expect(declared.status).toBe(413)
        const arrived = await post(big)
        expect(arrived.status).toBe(413)
        expect(recordMock).not.toHaveBeenCalled()
    })

    it.each([
        ['javascript:', 'a[href^="javascript:alert(1)"]'],
        ['url(', 'div[style*="url(x)"]'],
        ['expression', 'input[style*="expression"]'],
        ['a style block', 'input{color:red}'],
        ['a statement separator', 'input;'],
        ['a tag', '<input>'],
        ['a backslash escape', '#\\6a avascript'],
        ['a control character', '#promo\u0000'],
        ['a line break', '#promo\nbutton'],
        ['XPath', '//input[@id="promo"]'],
        ['parenthesised XPath', '(//input)[1]'],
        ['an over-long selector', `#${'a'.repeat(300)}`],
        ['an empty selector', '   '],
        [':has(', 'form:has(input)'],
        [':not(:has(', 'input:not(:has(span))'],
        [':nth-last-child', 'input:nth-last-child(1)'],
        ['an attribute outside the list', 'a[href="/cart"]'],
        ['a style attribute', 'input[style="x"]'],
        ['a class attribute', 'input[class="promo"]'],
        ['a selector list', '#promo, #code'],
        ['a pseudo-element', 'input::before'],
        ['five compounds', 'main form div label input'],
        [
            'four attribute selectors',
            'input[id="a"][name="b"][type="text"][placeholder="c"]',
        ],
        ['a quote inside a value', `input[name="it's"]`],
        ['a case flag', 'input[name="code" i]'],
    ])('bad selector (%s) in input is refused with 400', async (_, input) => {
        const res = await post(
            goodReport({
                box: { ...goodReport().box, input },
            }),
        )
        expect(res.status).toBe(400)
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('the same selector checks apply to apply and toggle', async () => {
        for (const field of ['apply', 'toggle'] as const) {
            const res = await post(
                goodReport({
                    box: {
                        ...goodReport().box,
                        [field]: 'javascript:void(0)',
                    },
                }),
            )
            expect(res.status).toBe(400)
        }
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('an apply or toggle naming checkout, payment, an order or a delete is refused with 400; the code field is not checked', async () => {
        for (const box of [
            { ...goodReport().box, apply: '#place-order' },
            { ...goodReport().box, apply: 'button[name="checkout"]' },
            { ...goodReport().box, toggle: '.remove-coupon' },
        ]) {
            expect((await post(goodReport({ box }))).status).toBe(400)
        }
        expect(recordMock).not.toHaveBeenCalled()
        const res = await post(
            goodReport({
                box: { ...goodReport().box, input: '#checkout_reduction_code' },
            }),
        )
        expect(res.status).toBe(200)
        expect(recordMock).toHaveBeenCalledTimes(1)
    })

    it('a selector carrying personal data is refused with 400', async () => {
        const res = await post(
            goodReport({
                box: {
                    ...goodReport().box,
                    input: 'input[data-customer-email="a@b.com"]',
                },
            }),
        )
        expect(res.status).toBe(400)
        expect(recordMock).not.toHaveBeenCalled()
    })

    it.each([
        ['an unknown top-level key', goodReport({ page: 'text' })],
        [
            'an unknown box key',
            goodReport({ box: { ...goodReport().box, html: '<b>' } }),
        ],
        ['no install id', goodReport({ installId: undefined })],
        ['a non-UUID install id', goodReport({ installId: 'abc' })],
        ['a bad domain', goodReport({ domain: 'shop example' })],
        ['a single-label domain', goodReport({ domain: 'intranet' })],
        ['localhost', goodReport({ domain: 'localhost' })],
        ['an IPv4 address', goodReport({ domain: '203.0.113.5' })],
        ['an unknown TLD', goodReport({ domain: 'shop.internal' })],
        ['a bare public suffix', goodReport({ domain: 'co.uk' })],
        ['broken punycode', goodReport({ domain: 'xn--garbage.com' })],
        [
            'free hosting (vercel.app)',
            goodReport({ domain: 'shop.vercel.app' }),
        ],
        ['free hosting (github.io)', goodReport({ domain: 'shop.github.io' })],
        [
            'a nested myshopify host',
            goodReport({ domain: 'a.b.myshopify.com' }),
        ],
        ['myshopify.com itself', goodReport({ domain: 'myshopify.com' })],
        ['an unknown source', goodReport({ source: 'magic' })],
        ['an unknown outcome', goodReport({ outcome: 'maybe' })],
        ['a confirmation without evidence', goodReport({ evidence: null })],
        [
            'enterOnly with an apply button',
            goodReport({ box: { ...goodReport().box, enterOnly: true } }),
        ],
        [
            'no apply button and not enterOnly',
            goodReport({ box: { ...goodReport().box, apply: null } }),
        ],
        [
            'input equal to apply',
            goodReport({
                box: { ...goodReport().box, apply: '#promo' },
            }),
        ],
        ['not JSON', '{nope'],
    ])('invalid body (%s) is refused with 400', async (_, body) => {
        const res = await post(body)
        expect(res.status).toBe(400)
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('a cap refusal is passed through as ignored', async () => {
        recordMock.mockImplementationOnce(async () => ({
            recorded: false,
            reason: 'ignored',
        }))
        const res = await post(goodReport())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ recorded: false, reason: 'ignored' })
    })

    it('a failure needs no evidence', async () => {
        const res = await post(
            goodReport({ outcome: 'failed', evidence: undefined }),
        )
        expect(await res.json()).toEqual({ recorded: true })
    })

    it('served-config domain: answered served_config and never recorded', async () => {
        servedMock.mockImplementation(async () => true)
        const res = await post(goodReport())
        expect(await res.json()).toEqual({
            recorded: false,
            reason: 'served_config',
        })
        expect(servedMock).toHaveBeenCalledWith('shop-example.com')
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('its own switch off (the pick still on): answers disabled without reading the body', async () => {
        envMock.COUPON_BOX_LEARNED_ENABLED = false
        const res = await post('{nope')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            recorded: false,
            reason: 'disabled',
        })
        expect(servedMock).not.toHaveBeenCalled()
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('off without a salt, and off with the pick off: answers disabled without reading the body', async () => {
        envMock.COUPON_BOX_LEARNED_SALT = undefined
        expect(await (await post('{nope')).json()).toEqual({
            recorded: false,
            reason: 'disabled',
        })
        envMock.COUPON_BOX_LEARNED_SALT = 'x'.repeat(40)
        envMock.COUPON_BOX_LLM_ENABLED = false
        expect(await (await post(goodReport())).json()).toEqual({
            recorded: false,
            reason: 'disabled',
        })
        expect(recordMock).not.toHaveBeenCalled()
    })

    it('hands the store to the pipeline only when the box is servable', async () => {
        await post(goodReport())
        expect(suggestMock).not.toHaveBeenCalled()
        recordMock.mockImplementationOnce(async () => ({
            recorded: true as const,
            counted: true,
            servable: true,
        }))
        await post(goodReport())
        expect(suggestMock).toHaveBeenCalledWith(
            'shop-example.com',
            hashNetworkAcrossStores('203.0.113.99'),
        )
    })

    it('a failed pipeline hand-over does not fail the committed report', async () => {
        recordMock.mockImplementationOnce(async () => ({
            recorded: true as const,
            counted: true,
            servable: true,
        }))
        suggestMock.mockImplementationOnce(async () => {
            throw new Error('db down')
        })
        const res = await post(goodReport())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ recorded: true })
    })

    it('keys reporters and the hand-over by the STORE, not the host: www., checkout. and the bare domain are one store', async () => {
        recordMock.mockImplementation(async () => ({
            recorded: true as const,
            counted: true,
            servable: true,
        }))
        try {
            for (const domain of [
                'www.shop-example.com',
                'checkout.shop-example.com',
                'shop-example.com',
            ]) {
                await post(goodReport({ domain }))
            }
        } finally {
            recordMock.mockImplementation(async () => ({
                recorded: true as const,
                counted: true,
                servable: false,
            }))
        }
        const calls = recordMock.mock.calls.map(
            c =>
                c[0] as {
                    report: { domain: string }
                    installHash: string
                    networkHash: string
                },
        )
        // The box is still filed under the host it was found on...
        expect(calls.map(c => c.report.domain)).toEqual([
            'www.shop-example.com',
            'checkout.shop-example.com',
            'shop-example.com',
        ])
        // ...but the install and its network are one reporter on all of them.
        expect(new Set(calls.map(c => c.installHash))).toEqual(
            new Set([hashInstallId(INSTALL_ID, 'shop-example.com')]),
        )
        expect(new Set(calls.map(c => c.networkHash))).toEqual(
            new Set([hashNetwork('203.0.113.5', 'shop-example.com')]),
        )
        expect(suggestMock.mock.calls.map(c => c[0])).toEqual([
            'shop-example.com',
            'shop-example.com',
            'shop-example.com',
        ])
    })

    it('a shop on myshopify.com is its own store, not every Shopify store', async () => {
        recordMock.mockImplementationOnce(async () => ({
            recorded: true as const,
            counted: true,
            servable: true,
        }))
        const res = await post(goodReport({ domain: 'mystore.myshopify.com' }))
        expect(await res.json()).toEqual({ recorded: true })
        const call = recordMock.mock.calls[0]?.[0] as { installHash: string }
        expect(call.installHash).toBe(
            hashInstallId(INSTALL_ID, 'mystore.myshopify.com'),
        )
        expect(suggestMock).toHaveBeenCalledWith(
            'mystore.myshopify.com',
            expect.stringMatching(/^[0-9a-f]{64}$/),
        )
    })

    it('a database error is a 500, never a quiet "recorded"', async () => {
        recordMock.mockImplementationOnce(async () => {
            throw new Error('db down')
        })
        const res = await post(goodReport())
        expect(res.status).toBe(500)
    })
})

describe('reporter identity', () => {
    it('networkPrefix keeps only /24 of IPv4 and /48 of IPv6', () => {
        expect(networkPrefix('203.0.113.77')).toBe('v4:203.0.113')
        expect(networkPrefix('::ffff:203.0.113.77')).toBe('v4:203.0.113')
        expect(networkPrefix('2001:db8:abcd:12::1')).toBe('v6:2001:db8:abcd')
        expect(networkPrefix('2001:db8::1')).toBe('v6:2001:db8:0')
        expect(networkPrefix('unknown')).toBe('unknown')
        expect(networkPrefix('999.1.1.1')).toBe('unknown')
    })

    it('hashes are per store: the same install and network hash differently on two stores', () => {
        expect(hashInstallId(INSTALL_ID, 'one-shop.com')).not.toBe(
            hashInstallId(INSTALL_ID, 'two-shop.com'),
        )
        expect(hashNetwork('203.0.113.5', 'one-shop.com')).not.toBe(
            hashNetwork('203.0.113.5', 'two-shop.com'),
        )
        expect(hashNetwork('203.0.113.5', 'one-shop.com')).toBe(
            hashNetwork('203.0.113.250', 'one-shop.com'),
        )
    })

    it('the cross-store network hash is per network PREFIX, not per address, and never equals a per-store hash', () => {
        expect(hashNetworkAcrossStores('203.0.113.5')).toBe(
            hashNetworkAcrossStores('203.0.113.250'),
        )
        expect(hashNetworkAcrossStores('203.0.113.5')).not.toBe(
            hashNetworkAcrossStores('203.0.114.5'),
        )
        // Every address of one IPv6 /48 is one network...
        expect(hashNetworkAcrossStores('2001:db8:abcd:1::1')).toBe(
            hashNetworkAcrossStores('2001:db8:abcd:ffff:1:2:3:4'),
        )
        expect(hashNetworkAcrossStores('2001:db8:abcd::1')).not.toBe(
            hashNetworkAcrossStores('2001:db8:abce::1'),
        )
        expect(hashNetworkAcrossStores('203.0.113.5')).not.toBe(
            hashNetwork('203.0.113.5', ''),
        )
    })

    it('hashes depend on the salt and never contain the input', () => {
        const a = hashInstallId(INSTALL_ID, 'shop-example.com')
        envMock.COUPON_BOX_LEARNED_SALT =
            'another-salt-another-salt-another-salt'
        expect(hashInstallId(INSTALL_ID, 'shop-example.com')).not.toBe(a)
        expect(a).not.toContain(INSTALL_ID.slice(0, 8))
    })

    it('refuses to hash without a salt (never a quiet unsalted hash)', () => {
        envMock.COUPON_BOX_LEARNED_SALT = undefined
        expect(() => hashInstallId(INSTALL_ID, 'shop-example.com')).toThrow(
            /COUPON_BOX_LEARNED_SALT/,
        )
    })

    it('learnedStoreDomain: the registrable domain, a myshopify shop, and nothing on free hosting', () => {
        expect(learnedStoreDomain('r1.walmart.com')).toBe('walmart.com')
        expect(learnedStoreDomain('www.shop.co.uk')).toBe('shop.co.uk')
        expect(learnedStoreDomain('mystore.myshopify.com')).toBe(
            'mystore.myshopify.com',
        )
        for (const host of [
            'a.b.myshopify.com',
            'myshopify.com',
            'shop.vercel.app',
            'shop.github.io',
            'shop.netlify.app',
            'shop.pages.dev',
            'shop.herokuapp.com',
            'co.uk',
            'localhost',
        ]) {
            expect(learnedStoreDomain(host)).toBeNull()
        }
    })

    it('the report schema accepts the contract shape', () => {
        expect(learnedBoxReportSchema.safeParse(goodReport()).success).toBe(
            true,
        )
        expect(
            learnedBoxReportSchema.safeParse(
                goodReport({
                    box: {
                        input: 'input[placeholder="Code promo"]',
                        apply: null,
                        toggle: 'button[aria-label="Ajouter un code"]',
                        enterOnly: true,
                    },
                    source: 'server_learned',
                    evidence: 'store_answered',
                }),
            ).success,
        ).toBe(true)
    })
})
