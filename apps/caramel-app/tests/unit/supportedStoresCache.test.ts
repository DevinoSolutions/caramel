import { GET } from '@/app/api/extension/supported-stores/route'
import {
    getSupportedStoresPayload,
    resetSupportedStoresCache,
    SUPPORTED_STORES_TTL_MS,
} from '@/lib/supportedStoresCache'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// supportedStoresCache — the in-process cache behind GET
// /api/extension/supported-stores. The route's ~1.2 MB body used to be
// rebuilt (SELECT + 15k-row map + stringify) on EVERY hit, blocking the
// event loop for seconds under extension-install traffic. Pinned here: one
// build per TTL window, concurrent callers share one build, a rebuild
// failure keeps serving the last good payload, an explicit reset forces a
// rebuild, and the route turns the cache into a strong ETag / 304.

const { queryRawMock } = vi.hoisted(() => ({
    queryRawMock: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => null) }))

const ROW = {
    store_name: 'example.com',
    show_input_xpath: null,
    dismiss_button_xpath: null,
    coupon_input_xpath: '//input[@id="promo"]',
    apply_button_xpath: '//button[@id="apply"]',
    price_container_xpath: null,
    success_indicator_xpath: null,
    error_indicator_xpath: null,
    coupon_remove_xpath: null,
}

beforeEach(() => {
    resetSupportedStoresCache()
    queryRawMock.mockReset()
    queryRawMock.mockResolvedValue([ROW])
})

describe('getSupportedStoresPayload', () => {
    it('builds once and serves the same serialized body until the TTL elapses', async () => {
        const first = await getSupportedStoresPayload(1_000)
        const second = await getSupportedStoresPayload(
            1_000 + SUPPORTED_STORES_TTL_MS - 1,
        )
        expect(queryRawMock).toHaveBeenCalledTimes(1)
        expect(second).toBe(first)
        expect(JSON.parse(first.body)).toEqual({
            supported: [
                {
                    domain: 'example.com',
                    couponInput: '//input[@id="promo"]',
                    couponSubmit: '//button[@id="apply"]',
                },
            ],
        })
        expect(first.etag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    })

    it('rebuilds after the TTL', async () => {
        const first = await getSupportedStoresPayload(1_000)
        queryRawMock.mockResolvedValue([{ ...ROW, store_name: 'other.com' }])
        const later = await getSupportedStoresPayload(
            first.builtAt + SUPPORTED_STORES_TTL_MS,
        )
        expect(queryRawMock).toHaveBeenCalledTimes(2)
        expect(later.body).toContain('other.com')
        expect(later.etag).not.toBe(first.etag)
    })

    it('de-duplicates concurrent builds into a single query', async () => {
        const results = await Promise.all([
            getSupportedStoresPayload(),
            getSupportedStoresPayload(),
            getSupportedStoresPayload(),
        ])
        expect(queryRawMock).toHaveBeenCalledTimes(1)
        expect(new Set(results).size).toBe(1)
    })

    it('keeps serving the last good payload when a rebuild throws', async () => {
        const good = await getSupportedStoresPayload(1_000)
        queryRawMock.mockRejectedValue(new Error('db down'))
        const stale = await getSupportedStoresPayload(
            good.builtAt + SUPPORTED_STORES_TTL_MS + 1,
        )
        expect(stale).toBe(good)
    })

    it('throws when there is no previous payload to fall back on', async () => {
        queryRawMock.mockRejectedValue(new Error('db down'))
        await expect(getSupportedStoresPayload()).rejects.toThrow('db down')
    })

    it('resetSupportedStoresCache forces the next call to rebuild', async () => {
        await getSupportedStoresPayload()
        resetSupportedStoresCache()
        await getSupportedStoresPayload()
        expect(queryRawMock).toHaveBeenCalledTimes(2)
    })
})

describe('GET /api/extension/supported-stores — served from the cache', () => {
    function makeRequest(headers: Record<string, string> = {}) {
        return new NextRequest(
            'http://localhost/api/extension/supported-stores',
            { headers },
        )
    }

    it('returns the cached JSON body with a strong ETag and the 5-min edge policy', async () => {
        const res = await GET(makeRequest())
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('application/json')
        expect(res.headers.get('cache-control')).toBe(
            'public, s-maxage=300, stale-while-revalidate=300',
        )
        const etag = res.headers.get('etag')
        expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/)
        await expect(res.json()).resolves.toEqual({
            supported: [
                {
                    domain: 'example.com',
                    couponInput: '//input[@id="promo"]',
                    couponSubmit: '//button[@id="apply"]',
                },
            ],
        })
    })

    it('two requests hit the database once', async () => {
        await GET(makeRequest())
        await GET(makeRequest())
        expect(queryRawMock).toHaveBeenCalledTimes(1)
    })

    it('answers 304 to a matching If-None-Match instead of resending 1.2 MB', async () => {
        const first = await GET(makeRequest())
        const etag = first.headers.get('etag') as string
        const res = await GET(makeRequest({ 'if-none-match': etag }))
        expect(res.status).toBe(304)
        expect(res.headers.get('etag')).toBe(etag)
        expect(await res.text()).toBe('')
    })

    it('a stale If-None-Match gets the full 200 body', async () => {
        const res = await GET(makeRequest({ 'if-none-match': '"nope"' }))
        expect(res.status).toBe(200)
    })
})
