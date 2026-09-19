import sitemap from '@/app/sitemap'
import type { MetadataRoute } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins src/app/sitemap.ts's composition contract (there was NO unit test for
// it until 2026-09 — the served sitemap drifted to 84 subdomain slugs, 2
// mixed-case slugs, 1 non-domain and 38 missing canonical targets before GSC
// told us; see caramel-artifact/seo-2026-09-11/audit-findings.md §Sitemap).
//
// BASE_URL is resolved at module scope in sitemap.ts, so it is mocked
// STATICALLY (one origin for the whole file) rather than per case like
// robots-env-contract.test.ts does: the store collapse loads tldts's Public
// Suffix List, which is far too heavy to re-import under resetModules for
// every case. The two catalog reads are mocked at the couponsRepo boundary so
// no SQL runs.

const ORIGIN = 'https://grabcaramel.com'

const { repoMock } = vi.hoisted(() => ({
    repoMock: {
        listStoreSitemapEntries: vi.fn(),
        listActiveSources: vi.fn(),
    },
}))
vi.mock('@/lib/couponsRepo', () => repoMock)
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://grabcaramel.com' }))

async function renderSitemap(): Promise<MetadataRoute.Sitemap> {
    return sitemap()
}

const d = (iso: string) => new Date(iso)

const ACTIVE_SOURCE = {
    id: 'src-1',
    source: 'Feed A',
    websites: ['gap.com'],
    status: 'ACTIVE',
    total_coupons: 3,
    total_used: 0,
    total_expired: 0,
}

beforeEach(() => {
    repoMock.listStoreSitemapEntries.mockReset()
    repoMock.listActiveSources.mockReset()
    repoMock.listStoreSitemapEntries.mockResolvedValue([])
    repoMock.listActiveSources.mockResolvedValue([])
})

function urlsOf(entries: MetadataRoute.Sitemap): string[] {
    return entries.map(e => e.url)
}

describe('sitemap.ts — static routes', () => {
    it('lists the public marketing routes including /support (monthly, 0.5) and never the auth/profile pages', async () => {
        const entries = await renderSitemap()
        const urls = urlsOf(entries)

        for (const path of [
            '/',
            '/coupons',
            '/supported-stores',
            '/pricing',
            '/support',
            '/privacy',
        ]) {
            expect(urls, `missing ${path}`).toContain(`${ORIGIN}${path}`)
        }
        const support = entries.find(e => e.url === `${ORIGIN}/support`)
        expect(support?.changeFrequency).toBe('monthly')
        expect(support?.priority).toBe(0.5)

        for (const path of ['/login', '/signup', '/verify', '/profile']) {
            expect(urls).not.toContain(`${ORIGIN}${path}`)
        }
    })

    it('omits /sources when there are no ACTIVE sources (an empty shell the page itself noindexes)', async () => {
        repoMock.listActiveSources.mockResolvedValue([])
        const urls = urlsOf(await renderSitemap())
        expect(urls).not.toContain(`${ORIGIN}/sources`)
    })

    it('emits /sources (weekly, 0.6) when at least one ACTIVE source exists', async () => {
        repoMock.listActiveSources.mockResolvedValue([ACTIVE_SOURCE])
        const entries = await renderSitemap()
        const sources = entries.find(e => e.url === `${ORIGIN}/sources`)
        expect(sources).toBeDefined()
        expect(sources?.changeFrequency).toBe('weekly')
        expect(sources?.priority).toBe(0.6)
    })
})

describe('sitemap.ts — store entries are canonical, lowercase, deduped, policy-gated', () => {
    it('emits ONE lowercase base-domain URL per registrable domain, folding subdomain and mixed-case slugs, dropping non-stores and 0-count sites', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue([
            {
                site: 'athleta.gap.com',
                coupon_count: 7,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'gap.com',
                coupon_count: 30,
                last_updated: d('2026-08-15T00:00:00Z'),
            },
            {
                site: 'Brooklinen.com',
                coupon_count: 2,
                last_updated: d('2026-07-01T00:00:00Z'),
            },
            {
                site: 'brooklinen.com',
                coupon_count: 9,
                last_updated: d('2026-09-05T00:00:00Z'),
            },
            {
                site: 'eNasco.com',
                coupon_count: 3,
                last_updated: d('2026-08-20T00:00:00Z'),
            },
            {
                site: 'dhl.com-us-en-home.html',
                coupon_count: 5,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'co.uk',
                coupon_count: 50,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
            {
                site: 'zero-codes.com',
                coupon_count: 0,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
        ])

        const entries = await renderSitemap()
        const storeUrls = urlsOf(entries).filter(u =>
            u.startsWith(`${ORIGIN}/coupons/`),
        )

        expect(storeUrls).toEqual([
            `${ORIGIN}/coupons/brooklinen.com`,
            `${ORIGIN}/coupons/enasco.com`,
            `${ORIGIN}/coupons/gap.com`,
        ])
        // No duplicates, every slug lowercase.
        expect(new Set(storeUrls).size).toBe(storeUrls.length)
        for (const url of storeUrls) expect(url).toBe(url.toLowerCase())
        // Never the raw variants.
        for (const raw of [
            'athleta.gap.com',
            'Brooklinen.com',
            'eNasco.com',
            'dhl.com-us-en-home.html',
            'co.uk',
            'zero-codes.com',
        ]) {
            expect(urlsOf(entries)).not.toContain(`${ORIGIN}/coupons/${raw}`)
        }

        // Store entries keep the existing crawl hints.
        const gap = entries.find(e => e.url === `${ORIGIN}/coupons/gap.com`)
        expect(gap?.changeFrequency).toBe('daily')
        expect(gap?.priority).toBe(0.7)
    })

    it('carries lastModified through as the newest updated_at folded into the base, and omits it when no row had one', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue([
            {
                site: 'athleta.gap.com',
                coupon_count: 7,
                last_updated: d('2026-09-10T12:00:00Z'),
            },
            {
                site: 'gap.com',
                coupon_count: 30,
                last_updated: d('2026-08-15T00:00:00Z'),
            },
            { site: 'nodate.com', coupon_count: 1, last_updated: null },
        ])

        const entries = await renderSitemap()
        const gap = entries.find(e => e.url === `${ORIGIN}/coupons/gap.com`)
        expect(gap?.lastModified).toEqual(d('2026-09-10T12:00:00Z'))

        const nodate = entries.find(
            e => e.url === `${ORIGIN}/coupons/nodate.com`,
        )
        expect(nodate).toBeDefined()
        expect(nodate?.lastModified).toBeUndefined()
        // Static routes never invent a date either.
        expect(
            entries.find(e => e.url === `${ORIGIN}/`)?.lastModified,
        ).toBeUndefined()
    })

    it('reads grouped rows under the 5000 cap and encodes the base into the URL', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue([
            {
                site: 'mymemory.co.uk',
                coupon_count: 4,
                last_updated: d('2026-09-01T00:00:00Z'),
            },
        ])
        const entries = await renderSitemap()
        expect(repoMock.listStoreSitemapEntries).toHaveBeenCalledWith(5000)
        expect(urlsOf(entries)).toContain(`${ORIGIN}/coupons/mymemory.co.uk`)
    })

    it('with an empty catalog emits only the static routes', async () => {
        const entries = await renderSitemap()
        expect(
            urlsOf(entries).some(u => u.startsWith(`${ORIGIN}/coupons/`)),
        ).toBe(false)
        expect(entries.length).toBe(6)
    })
})
