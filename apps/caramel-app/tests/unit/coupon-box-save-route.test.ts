import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-save: every rule, in the contract's order,
// and every answer. The writes and the catalog reads run on real Postgres in
// tests/integration/coupon-box-save.itest.ts.

// MOCK (announced): the three database calls the route makes and the
// supported-stores cache. What they are asked, and whether they are asked at
// all, is what these tests measure.
const { envMock, knownMock, servedMock, insertMock, resetCacheMock } =
    vi.hoisted(() => ({
        envMock: {} as Record<string, unknown>,
        knownMock: vi.fn(
            async (
                _names: readonly string[],
                _shopLabel: string | null,
            ): Promise<string[]> => ['shop-example.com'],
        ),
        servedMock: vi.fn(async (_host: string) => false),
        insertMock: vi.fn(
            async (_config: unknown): Promise<{ inserted: boolean }> => ({
                inserted: true,
            }),
        ),
        resetCacheMock: vi.fn(),
    }))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/couponsRepo', () => ({
    findCatalogStoreNames: knownMock,
    hasServedStoreConfig: servedMock,
}))
vi.mock('@/lib/catalog/applyCatalogRows', () => ({
    insertAutoDetectedStoreConfig: insertMock,
}))
vi.mock('@/lib/supportedStoresCache', () => ({
    resetSupportedStoresCache: resetCacheMock,
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

import { OPTIONS, POST } from '@/app/api/extension/coupon-box-save/route'
import { checkRateLimit } from '@/lib/rateLimit'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const goodBody = (
    box: Record<string, unknown> = {},
    host = 'www.shop-example.com',
) => ({
    host,
    box: {
        input: '#promo',
        apply: 'button[name="apply"]',
        toggle: null,
        total: '.order-total',
        ...box,
    },
})

function post(
    body: unknown,
    { origin = EXT_ORIGIN }: { origin?: string | null } = {},
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    }
    if (origin) headers.origin = origin
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-save', {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    envMock.COUPON_BOX_SAVE_ENABLED = true
    knownMock.mockReset()
    knownMock.mockImplementation(async () => ['shop-example.com'])
    servedMock.mockReset()
    servedMock.mockImplementation(async () => false)
    insertMock.mockReset()
    insertMock.mockImplementation(async () => ({ inserted: true }))
    resetCacheMock.mockReset()
})

describe('POST /api/extension/coupon-box-save', () => {
    it('saves the box under the catalog store, mapped to the store_configs columns, then drops the supported-stores cache', async () => {
        const res = await post(goodBody())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            saved: true,
            store: 'shop-example.com',
        })
        expect(insertMock).toHaveBeenCalledTimes(1)
        expect(insertMock).toHaveBeenCalledWith({
            storeName: 'shop-example.com',
            couponInputXpath: '#promo',
            applyButtonXpath: 'button[name="apply"]',
            showInputXpath: null,
            priceContainerXpath: '.order-total',
        })
        expect(servedMock).toHaveBeenCalledWith('www.shop-example.com')
        expect(resetCacheMock).toHaveBeenCalledTimes(1)
        expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('an Enter-only box (apply null) stores its input as the apply selector; the toggle is show_input', async () => {
        await post(goodBody({ apply: null, toggle: 'button.reveal-promo' }))

        expect(insertMock).toHaveBeenCalledWith({
            storeName: 'shop-example.com',
            couponInputXpath: '#promo',
            applyButtonXpath: '#promo',
            showInputXpath: 'button.reveal-promo',
            priceContainerXpath: '.order-total',
        })
    })

    it('1. flag off: 404 disabled, the body is never read and nothing is asked', async () => {
        envMock.COUPON_BOX_SAVE_ENABLED = false

        const res = await post('not even json')

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ saved: false, reason: 'disabled' })
        expect(knownMock).not.toHaveBeenCalled()
        expect(servedMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
    })

    it.each([
        ['not JSON', '{nope'],
        ['no box', { host: 'www.shop-example.com' }],
        ['no input', goodBody({ input: undefined })],
        ['an empty input', goodBody({ input: '' })],
        ['a selector list', goodBody({ input: '#a, #b' })],
        ['a :has() selector', goodBody({ input: 'form:has(input)' })],
        ['an XPath', goodBody({ input: '//input[@id="promo"]' })],
        ['an email in a selector', goodBody({ total: '[data-user="a@b.co"]' })],
        [
            'a long number in a value',
            goodBody({ apply: '[data-phone="5551234567"]' }),
        ],
        [
            'an apply that places the order',
            goodBody({ apply: 'button#place-order' }),
        ],
        ['a toggle that pays', goodBody({ toggle: 'button.pay-now' })],
        ['a code in the body', { ...goodBody(), code: 'SAVE10' }],
        ['an amount in the box', goodBody({ amount: 5 })],
        ['a host with a path', goodBody({}, 'shop-example.com/cart')],
        ['a host with a space', goodBody({}, 'shop example.com')],
    ])('2. %s: 400 invalid_selector, nothing asked', async (_name, body) => {
        const res = await post(body)

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'invalid_selector',
        })
        expect(knownMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('a body over 4 KiB: 413 too_large', async () => {
        const res = await post(goodBody({ input: `#${'a'.repeat(5000)}` }))

        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ saved: false, reason: 'too_large' })
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('3. a host the catalog does not know: 404 unknown_store, never a served-config read or a write', async () => {
        knownMock.mockImplementation(async () => [])

        const res = await post(goodBody())

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'unknown_store',
        })
        expect(servedMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('3. a host that names no registrable store (localhost, a bare suffix) is unknown without a query', async () => {
        for (const host of ['localhost', 'co.uk']) {
            const res = await post(goodBody({}, host))
            expect(res.status).toBe(404)
            expect(await res.json()).toEqual({
                saved: false,
                reason: 'unknown_store',
            })
        }
        expect(knownMock).not.toHaveBeenCalled()
    })

    it('4. a store with a served config: 409 has_config, nothing written', async () => {
        servedMock.mockImplementation(async () => true)

        const res = await post(goodBody())

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ saved: false, reason: 'has_config' })
        expect(insertMock).not.toHaveBeenCalled()
        expect(resetCacheMock).not.toHaveBeenCalled()
    })

    it('5. the insert finds a row already there (a racing save, or an unserved config): 409 has_config, the cache is kept', async () => {
        insertMock.mockImplementation(async () => ({ inserted: false }))

        const res = await post(goodBody())

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ saved: false, reason: 'has_config' })
        expect(resetCacheMock).not.toHaveBeenCalled()
    })

    it('a database failure is a 500, never a quiet answer', async () => {
        insertMock.mockImplementation(async () => {
            throw new Error('connection lost')
        })

        const res = await post(goodBody())

        expect(res.status).toBe(500)
        expect(resetCacheMock).not.toHaveBeenCalled()
    })

    it('refuses a request without an extension Origin (403) before reading anything', async () => {
        const web = await post(goodBody(), { origin: 'https://evil.example' })
        const none = await post(goodBody(), { origin: null })

        expect(web.status).toBe(403)
        expect(none.status).toBe(403)
        expect(knownMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('is rate-limited as a mutation', async () => {
        await post(goodBody())

        expect(checkRateLimit).toHaveBeenCalledWith(
            expect.anything(),
            'mutation',
        )
    })

    it('answers a preflight (OPTIONS) with 204', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/coupon-box-save', {
                method: 'OPTIONS',
                headers: { origin: EXT_ORIGIN },
            }),
        )

        expect(res.status).toBe(204)
    })
})
