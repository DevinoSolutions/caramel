import { GET as filtersGET } from '@/app/api/coupons/filters/route'
import { GET as statsGET } from '@/app/api/coupons/stats/route'
import { POST as searchSupportedPOST } from '@/app/api/sites/search-supported/route'
import { GET as topSitesGET } from '@/app/api/sites/top-sites/route'
import { GET as sourcesGET, POST as sourcesPOST } from '@/app/api/sources/route'
import { resetAnonymousReadCaches } from '@/lib/anonymousReadCaches'
import { resetAnonymousWriteQuotas } from '@/lib/anonymousWriteQuota'
import { createLoadingTtlLruCache } from '@/lib/ttlLruCache'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-6229 / T-6226 / T-6225 — the anonymous catalog routes. The repo layer is
// ANNOUNCED-FAKED here (couponsRepo is mocked wholesale, so no SQL runs): these
// pins are about what the ROUTES hand the repo and how often, not about query
// shape (coupons-read-boundary / couponsRepo tests own that).
const repo = vi.hoisted(() => ({
    getCouponStats: vi.fn(async () => ({ total: 10, expired: 4 })),
    listActiveSources: vi.fn(async () => [] as unknown[]),
    listFilterDiscountTypes: vi.fn(async () => [
        { discount_type: 'percentage' },
    ]),
    listFilterSites: vi.fn(async (_limit: number) => [
        { site: 'b.com' },
        { site: 'a.com' },
    ]),
    listTopSites: vi.fn(async () => [{ site: 'a.com', coupon_count: 3 }]),
    searchSupportedSites: vi.fn(async (_q: string) => [{ site: 'amazon.com' }]),
    requestSource: vi.fn(
        async (_host: string) =>
            'created' as 'created' | 'duplicate' | 'queue_full',
    ),
}))
vi.mock('@/lib/couponsRepo', () => repo)

// siteSuggestions.ts (the hostname normalizer the sources route reuses) imports
// the prisma client; nothing here touches it, so an empty stand-in is enough.
vi.mock('@/lib/prisma', () => ({ default: {} }))

vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
    isTrustedServer: () => false,
    isOriginAllowed: () => true,
    forbiddenOrigin: () =>
        new Response(JSON.stringify({ error: 'Forbidden origin' }), {
            status: 403,
        }),
}))

const { captureMessageMock } = vi.hoisted(() => ({
    captureMessageMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
    setUser: vi.fn(),
}))

beforeEach(() => {
    resetAnonymousReadCaches()
    resetAnonymousWriteQuotas()
    captureMessageMock.mockClear()
    for (const fn of Object.values(repo)) fn.mockClear()
    repo.requestSource.mockResolvedValue('created')
})

function get(path: string) {
    return new NextRequest(`http://localhost${path}`)
}

function post(path: string, body: unknown) {
    return new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

describe('GET /api/coupons/filters — sitesLimit parsing (T-6229)', () => {
    it.each([
        ['abc', 20],
        ['', 20],
        ['NaN', 20],
        ['Infinity', 20],
        ['1e3', 20],
        ['5abc', 20],
        ['0x10', 20],
        ['--5', 20],
        ['99999999999999999999', 20],
        ['5', 5],
        [' 7 ', 7],
        ['100', 100],
        ['101', 100],
        ['999999999', 100],
        ['-5', 0],
        ['0', 0],
    ])('sitesLimit=%j reaches the repo as %i, never NaN', async (raw, want) => {
        const res = await filtersGET(
            get(`/api/coupons/filters?sitesLimit=${encodeURIComponent(raw)}`),
        )
        expect(res.status).toBe(200)
        // 0 reaches the repo too: listFilterSites short-circuits it to [].
        expect(repo.listFilterSites).toHaveBeenCalledWith(want)
    })

    it('no sitesLimit at all keeps the documented default of 20', async () => {
        await filtersGET(get('/api/coupons/filters'))
        expect(repo.listFilterSites).toHaveBeenCalledWith(20)
    })

    it('every limit the repo can be called with is a finite integer in 0..100', async () => {
        for (const raw of ['abc', 'NaN', '1e9', '-1', '50', '500', '']) {
            resetAnonymousReadCaches()
            await filtersGET(get(`/api/coupons/filters?sitesLimit=${raw}`))
        }
        for (const [limit] of repo.listFilterSites.mock.calls) {
            expect(Number.isInteger(limit)).toBe(true)
            expect(limit).toBeGreaterThanOrEqual(0)
            expect(limit).toBeLessThanOrEqual(100)
        }
    })

    it('the response keeps its shape: sorted sites + discount types', async () => {
        const res = await filtersGET(get('/api/coupons/filters?sitesLimit=abc'))
        expect(await res.json()).toEqual({
            sites: ['a.com', 'b.com'],
            discountTypes: ['percentage'],
        })
    })
})

describe('anonymous DB-heavy reads are cached in-process (T-6226)', () => {
    it('filters: unique query strings and unknown params do not reach Postgres again', async () => {
        await filtersGET(get('/api/coupons/filters?sitesLimit=20&bust=1'))
        await filtersGET(get('/api/coupons/filters?sitesLimit=20&bust=2'))
        await filtersGET(get('/api/coupons/filters?bust=3'))
        expect(repo.listFilterSites).toHaveBeenCalledTimes(1)
        expect(repo.listFilterDiscountTypes).toHaveBeenCalledTimes(1)
    })

    it('filters: a different limit is a different entry, and includeSites=false never reads sites', async () => {
        await filtersGET(get('/api/coupons/filters?sitesLimit=5'))
        await filtersGET(get('/api/coupons/filters?sitesLimit=6'))
        expect(repo.listFilterSites).toHaveBeenCalledTimes(2)
        await filtersGET(get('/api/coupons/filters?includeSites=false&x=1'))
        expect(repo.listFilterSites).toHaveBeenCalledTimes(2)
        expect(repo.listFilterDiscountTypes).toHaveBeenCalledTimes(1)
    })

    it('stats: one count per TTL, same answer', async () => {
        const first = await (await statsGET(get('/api/coupons/stats'))).json()
        const again = await (
            await statsGET(get('/api/coupons/stats?cb=9'))
        ).json()
        expect(first).toEqual({ total: 10, expired: 4, active: 6 })
        expect(again).toEqual(first)
        expect(repo.getCouponStats).toHaveBeenCalledTimes(1)
    })

    it('top-sites: one aggregate per TTL', async () => {
        await topSitesGET(get('/api/sites/top-sites'))
        const res = await topSitesGET(get('/api/sites/top-sites?cb=1'))
        expect(await res.json()).toEqual({ sites: ['a.com'] })
        expect(repo.listTopSites).toHaveBeenCalledTimes(1)
    })

    it('sources GET: one aggregate per TTL', async () => {
        repo.listActiveSources.mockResolvedValue([
            {
                id: 's1',
                source: 'Example',
                websites: ['example.com'],
                status: 'ACTIVE',
                total_coupons: 4,
                total_used: 1,
                total_expired: 1,
            },
        ])
        await sourcesGET(get('/api/sources'))
        const res = await sourcesGET(get('/api/sources?cb=1'))
        expect((await res.json()).data).toHaveLength(1)
        expect(repo.listActiveSources).toHaveBeenCalledTimes(1)
    })

    it('a failing read is NOT cached: the next request retries and the failure surfaces as a 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        repo.getCouponStats.mockRejectedValueOnce(new Error('db down'))
        const failed = await statsGET(get('/api/coupons/stats'))
        expect(failed.status).toBe(500)
        const retried = await statsGET(get('/api/coupons/stats'))
        expect(retried.status).toBe(200)
        expect(repo.getCouponStats).toHaveBeenCalledTimes(2)
    })

    it('the cached filters array is not mutated by the route (sort works on a copy)', async () => {
        await filtersGET(get('/api/coupons/filters'))
        const res = await filtersGET(get('/api/coupons/filters'))
        expect((await res.json()).sites).toEqual(['a.com', 'b.com'])
    })
})

describe('POST /api/sites/search-supported — term floor + LRU (T-6226)', () => {
    it.each([['a'], [' a '], ['A'], ['https://'], ['']])(
        'a term shorter than two characters (%j) answers an empty list WITHOUT querying',
        async query => {
            const res = await searchSupportedPOST(
                post('/api/sites/search-supported', { query }),
            )
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ sites: [] })
            expect(repo.searchSupportedSites).not.toHaveBeenCalled()
        },
    )

    it('a two-character term still searches (the floor is exactly 2)', async () => {
        await searchSupportedPOST(
            post('/api/sites/search-supported', { query: 'am' }),
        )
        expect(repo.searchSupportedSites).toHaveBeenCalledWith('am')
    })

    it('the same normalized term is one query: URL, case and www forms share an entry', async () => {
        for (const query of [
            'amazon.com',
            'AMAZON.com',
            'https://www.amazon.com/dp/B0?x=1',
        ]) {
            const res = await searchSupportedPOST(
                post('/api/sites/search-supported', { query }),
            )
            expect(await res.json()).toEqual({ sites: ['amazon.com'] })
        }
        expect(repo.searchSupportedSites).toHaveBeenCalledTimes(1)
        expect(repo.searchSupportedSites).toHaveBeenCalledWith('amazon.com')
    })

    it('non-string and missing queries stay lenient (200, empty), never a 422', async () => {
        for (const body of [{}, { query: 5 }, { query: null }, { query: {} }]) {
            const res = await searchSupportedPOST(
                post('/api/sites/search-supported', body),
            )
            expect(res.status).toBe(200)
        }
    })
})

describe('POST /api/sources — bounded, normalized request (T-6225)', () => {
    it('stores the lowercased HOSTNAME, not the typed string (path, query, userinfo and www dropped)', async () => {
        const res = await sourcesPOST(
            post('/api/sources', {
                website: 'https://user:pw@WWW.Example-Store.com/a/b?c=d#e',
            }),
        )
        expect(res.status).toBe(200)
        expect(repo.requestSource).toHaveBeenCalledTimes(1)
        expect(repo.requestSource).toHaveBeenCalledWith('example-store.com')
    })

    it('a bare domain is accepted, including one that merely starts with "http"', async () => {
        await sourcesPOST(post('/api/sources', { website: 'httpbin.org' }))
        expect(repo.requestSource).toHaveBeenCalledWith('httpbin.org')
    })

    it('a website over the 2048-character field limit is refused with a 422 and nothing is stored', async () => {
        const res = await sourcesPOST(
            post('/api/sources', {
                website: `https://valid.com/${'a'.repeat(3_000)}`,
            }),
        )
        expect(res.status).toBe(422)
        expect(repo.requestSource).not.toHaveBeenCalled()
    })

    // #430 (T-6223) caps every withRoute body at 64 KiB by default, so a
    // megabyte payload is now refused by the body cap (413) before zod runs.
    it('a megabyte-long website body is refused with a 413 before anything is parsed or stored', async () => {
        const res = await sourcesPOST(
            post('/api/sources', {
                website: `https://valid.com/${'a'.repeat(1_000_000)}`,
            }),
        )
        expect(res.status).toBe(413)
        expect(repo.requestSource).not.toHaveBeenCalled()
    })

    it('a trailing-dot host is stored without the dot (it is the same store)', async () => {
        await sourcesPOST(
            post('/api/sources', { website: 'https://example.com./path' }),
        )
        expect(repo.requestSource).toHaveBeenCalledWith('example.com')
    })

    it.each([
        ['not a domain'],
        ['https://localhost'],
        ['https://a..b'],
        ['zzz1.xx'],
        ['co.uk'],
    ])('an implausible host (%s) keeps the pre-existing 400', async website => {
        const res = await sourcesPOST(post('/api/sources', { website }))
        expect(res.status).toBe(400)
        expect(repo.requestSource).not.toHaveBeenCalled()
    })

    it('a duplicate request is answered exactly like a fresh one (nothing to probe)', async () => {
        const fresh = await sourcesPOST(
            post('/api/sources', { website: 'example.com' }),
        )
        repo.requestSource.mockResolvedValueOnce('duplicate')
        const again = await sourcesPOST(
            post('/api/sources', { website: 'example.com' }),
        )
        expect(again.status).toBe(fresh.status)
        expect(await again.json()).toEqual(await fresh.json())
    })

    it('a full queue answers 429 with a message the page toast can show, and tells Sentry', async () => {
        repo.requestSource.mockResolvedValueOnce('queue_full')
        const res = await sourcesPOST(
            post('/api/sources', { website: 'example.com' }),
        )
        expect(res.status).toBe(429)
        const body = await res.json()
        expect(typeof body.error).toBe('string')
        expect(body.error.length).toBeGreaterThan(0)
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
    })

    it('per-address hourly quota: the 6th request from one address is a 429 with Retry-After and never reaches the repo; another address is unaffected', async () => {
        const from = (ip: string, website: string) =>
            sourcesPOST(
                new NextRequest('http://localhost/api/sources', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'cf-connecting-ip': ip,
                    },
                    body: JSON.stringify({ website }),
                }),
            )
        for (let i = 1; i <= 5; i += 1) {
            expect((await from('203.0.113.7', `store-${i}.com`)).status).toBe(
                200,
            )
        }
        const blocked = await from('203.0.113.7', 'store-6.com')
        expect(blocked.status).toBe(429)
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(typeof (await blocked.json()).error).toBe('string')
        expect(repo.requestSource).toHaveBeenCalledTimes(5)

        expect((await from('203.0.113.8', 'store-6.com')).status).toBe(200)
        expect(repo.requestSource).toHaveBeenCalledTimes(6)
    })

    it('a repo failure is a 500, not a swallowed success', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        repo.requestSource.mockRejectedValueOnce(new Error('db down'))
        const res = await sourcesPOST(
            post('/api/sources', { website: 'example.com' }),
        )
        expect(res.status).toBe(500)
    })
})

describe('createLoadingTtlLruCache', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('runs the loader once for concurrent callers of the same key', async () => {
        const cache = createLoadingTtlLruCache<number>({
            ttlMs: 1000,
            maxEntries: 4,
        })
        const loader = vi.fn(async () => 7)
        const [a, b] = await Promise.all([
            cache.load('k', loader),
            cache.load('k', loader),
        ])
        expect([a, b]).toEqual([7, 7])
        expect(loader).toHaveBeenCalledTimes(1)
        await cache.load('k', loader)
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it('reloads after the TTL', async () => {
        vi.useFakeTimers()
        const cache = createLoadingTtlLruCache<number>({
            ttlMs: 1000,
            maxEntries: 4,
        })
        const loader = vi.fn(async () => 1)
        await cache.load('k', loader)
        vi.advanceTimersByTime(1001)
        await cache.load('k', loader)
        expect(loader).toHaveBeenCalledTimes(2)
    })

    it('evicts the least recently used entry past maxEntries', async () => {
        const cache = createLoadingTtlLruCache<string>({
            ttlMs: 60_000,
            maxEntries: 2,
        })
        const loader = vi.fn(async () => 'v')
        await cache.load('a', loader)
        await cache.load('b', loader)
        await cache.load('a', loader) // refresh a; b is now oldest
        await cache.load('c', loader) // evicts b
        expect(loader).toHaveBeenCalledTimes(3)
        await cache.load('a', loader)
        await cache.load('c', loader)
        expect(loader).toHaveBeenCalledTimes(3)
        await cache.load('b', loader)
        expect(loader).toHaveBeenCalledTimes(4)
    })

    it('does not cache a rejection and shows every sharer the same error', async () => {
        const cache = createLoadingTtlLruCache<number>({
            ttlMs: 1000,
            maxEntries: 4,
        })
        const boom = new Error('boom')
        const failing = vi.fn(async () => {
            throw boom
        })
        const results = await Promise.allSettled([
            cache.load('k', failing),
            cache.load('k', failing),
        ])
        expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
        expect(failing).toHaveBeenCalledTimes(1)
        await expect(cache.load('k', async () => 5)).resolves.toBe(5)
    })

    it('a load that was in flight across reset() does not repopulate the new cache', async () => {
        const cache = createLoadingTtlLruCache<number>({
            ttlMs: 1000,
            maxEntries: 4,
        })
        let release: (value: number) => void = () => {}
        const slow = cache.load(
            'k',
            () => new Promise<number>(resolve => (release = resolve)),
        )
        cache.reset()
        release(1)
        await slow
        const fresh = vi.fn(async () => 2)
        await expect(cache.load('k', fresh)).resolves.toBe(2)
        expect(fresh).toHaveBeenCalledTimes(1)
    })
})
