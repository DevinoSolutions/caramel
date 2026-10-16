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
    recordMock: vi.fn(async (_input: unknown) => ({
        recorded: true as const,
        counted: true,
        servable: false,
    })),
    servedMock: vi.fn(async (_host: string) => false),
    suggestMock: vi.fn(async (_host: string) => ({ created: true })),
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/couponBoxLearned', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/couponBoxLearned')>()),
    recordLearnedBoxReport: recordMock,
}))
vi.mock('@/lib/couponsRepo', () => ({ hasServedStoreConfig: servedMock }))
vi.mock('@/lib/siteSuggestions', () => ({
    recordAutoDetectedStoreSuggestion: suggestMock,
}))
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
    learnedBoxReportSchema,
    networkPrefix,
} from '@/lib/couponBoxLearned'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const INSTALL_ID = '3f0c6a52-6a1e-4b8e-9d1f-2b7c1e0a9f44'

const goodReport = (overrides: Record<string, unknown> = {}) => ({
    installId: INSTALL_ID,
    domain: 'shop.example',
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
        }
        expect(call.installHash).toBe(hashInstallId(INSTALL_ID))
        expect(call.installHash).toMatch(/^[0-9a-f]{64}$/)
        expect(call.installHash).not.toContain(INSTALL_ID)
        expect(call.networkHash).toBe(hashNetwork('203.0.113.99'))
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

    it.each([
        ['an unknown top-level key', goodReport({ page: 'text' })],
        [
            'an unknown box key',
            goodReport({ box: { ...goodReport().box, html: '<b>' } }),
        ],
        ['no install id', goodReport({ installId: undefined })],
        ['a non-UUID install id', goodReport({ installId: 'abc' })],
        ['a bad domain', goodReport({ domain: 'shop example' })],
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
        expect(servedMock).toHaveBeenCalledWith('shop.example')
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
        expect(suggestMock).toHaveBeenCalledWith('shop.example')
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

    it('hashes depend on the salt and never contain the input', () => {
        const a = hashInstallId(INSTALL_ID)
        envMock.COUPON_BOX_LEARNED_SALT =
            'another-salt-another-salt-another-salt'
        expect(hashInstallId(INSTALL_ID)).not.toBe(a)
        expect(a).not.toContain(INSTALL_ID.slice(0, 8))
    })

    it('refuses to hash without a salt (never a quiet unsalted hash)', () => {
        envMock.COUPON_BOX_LEARNED_SALT = undefined
        expect(() => hashInstallId(INSTALL_ID)).toThrow(
            /COUPON_BOX_LEARNED_SALT/,
        )
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
