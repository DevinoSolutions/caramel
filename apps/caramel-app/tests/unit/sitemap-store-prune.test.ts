import sitemap from '@/app/sitemap'
import { isPrunedFromSitemap } from '@/lib/seo/sitemapStorePrune'
import {
    SITEMAP_PRUNE_BASES,
    SITEMAP_PRUNE_WINDOW_START,
} from '@/lib/seo/sitemapStorePrune.data'
import { resolveStoreDomain } from '@/lib/storeDomain'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T-15493 — the zero-impression store pages leave the sitemap, nothing else
// changes. Pins: (1) the prune decision (listed AND old enough to judge),
// (2) src/app/sitemap.ts applies it to store <loc>s only and keeps bucketing
// the A–Z letter pages from ALL stores, (3) the generated list is well formed,
// (4) the prune is wired into the sitemap and nowhere else, so a pruned page
// stays live and indexable.
//
// The prune list is mocked to a 3-store fixture for the behaviour tests
// (the real one is thousands long); the data-file and wiring tests below read
// the REAL generated module / source tree.

const ORIGIN = 'https://grabcaramel.com'
const WINDOW_START = '2026-08-07'

const { repoMock } = vi.hoisted(() => ({
    repoMock: {
        listStoreSitemapEntries: vi.fn(),
        listActiveSources: vi.fn(),
    },
}))
vi.mock('@/lib/couponsRepo', () => repoMock)
vi.mock('@/lib/env.client', () => ({ BASE_URL: 'https://grabcaramel.com' }))
vi.mock('@/lib/seo/sitemapStorePrune.data', () => ({
    SITEMAP_PRUNE_WINDOW_START: '2026-08-07',
    SITEMAP_PRUNE_BASES: ['oldquiet.com', 'newquiet.com', 'unknownage.com'],
}))

const d = (iso: string) => new Date(iso)

function row(site: string, firstCreated: string | undefined) {
    return {
        site,
        coupon_count: 3,
        last_updated: d('2026-10-01T00:00:00Z'),
        ...(firstCreated === undefined
            ? {}
            : { first_created: d(firstCreated) }),
    }
}

beforeEach(() => {
    repoMock.listStoreSitemapEntries.mockReset()
    repoMock.listActiveSources.mockReset()
    repoMock.listActiveSources.mockResolvedValue([])
})

function storeUrls(entries: Awaited<ReturnType<typeof sitemap>>): string[] {
    return entries
        .map(e => e.url)
        .filter(
            u =>
                u.startsWith(`${ORIGIN}/coupons/`) &&
                !u.startsWith(`${ORIGIN}/coupons/stores`),
        )
}

describe('isPrunedFromSitemap — listed AND old enough to judge', () => {
    it('prunes a listed base whose oldest coupon predates the window start', () => {
        expect(
            isPrunedFromSitemap({
                base: 'oldquiet.com',
                firstCreatedAt: d('2026-05-13T01:40:42Z'),
            }),
        ).toBe(true)
    })

    it('prunes a listed base created exactly at the window start (the window is fully covered)', () => {
        expect(
            isPrunedFromSitemap({
                base: 'oldquiet.com',
                firstCreatedAt: d(`${WINDOW_START}T00:00:00Z`),
            }),
        ).toBe(true)
    })

    it('keeps a listed base whose page is younger than the window (too new to judge)', () => {
        expect(
            isPrunedFromSitemap({
                base: 'newquiet.com',
                firstCreatedAt: d('2026-09-15T00:00:00Z'),
            }),
        ).toBe(false)
        expect(
            isPrunedFromSitemap({
                base: 'newquiet.com',
                firstCreatedAt: d(`${WINDOW_START}T00:00:01Z`),
            }),
        ).toBe(false)
    })

    it('keeps a listed base whose age is unknown', () => {
        expect(
            isPrunedFromSitemap({
                base: 'unknownage.com',
                firstCreatedAt: null,
            }),
        ).toBe(false)
    })

    it('keeps a base that is not on the list, however old', () => {
        expect(
            isPrunedFromSitemap({
                base: 'popular.com',
                firstCreatedAt: d('2026-01-01T00:00:00Z'),
            }),
        ).toBe(false)
    })
})

describe('sitemap.ts — pruned stores leave the <loc>s, nothing else moves', () => {
    const rows = [
        row('oldquiet.com', '2026-05-13T01:40:42Z'),
        row('newquiet.com', '2026-09-15T00:00:00Z'),
        row('unknownage.com', undefined),
        row('popular.com', '2026-05-13T01:40:42Z'),
    ]

    it('omits a listed old base, keeps a listed young base, a listed NULL-age base and an unlisted base', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue(rows)

        const urls = storeUrls(await sitemap())

        expect(urls).not.toContain(`${ORIGIN}/coupons/oldquiet.com`)
        expect(urls.sort()).toEqual([
            `${ORIGIN}/coupons/newquiet.com`,
            `${ORIGIN}/coupons/popular.com`,
            `${ORIGIN}/coupons/unknownage.com`,
        ])
    })

    it('folds subdomain slugs first: the OLDEST creation across the folded slugs decides, and an unknown one keeps the base', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue([
            // Both slugs of oldquiet.com are old -> pruned.
            row('shop.oldquiet.com', '2026-06-01T00:00:00Z'),
            row('oldquiet.com', '2026-05-13T01:40:42Z'),
            // One slug of newquiet.com is old but the oldest still counts as
            // the page's age, so it is pruned only if the OLDEST predates the
            // window; here the oldest is young.
            row('shop.newquiet.com', '2026-09-20T00:00:00Z'),
            row('newquiet.com', '2026-09-15T00:00:00Z'),
            // One folded slug has no known age -> the base stays.
            row('a.unknownage.com', undefined),
            row('unknownage.com', '2026-05-13T01:40:42Z'),
        ])

        const urls = storeUrls(await sitemap())

        expect(urls).not.toContain(`${ORIGIN}/coupons/oldquiet.com`)
        expect(urls).toContain(`${ORIGIN}/coupons/newquiet.com`)
        expect(urls).toContain(`${ORIGIN}/coupons/unknownage.com`)
    })

    it('leaves the A–Z letter pages bucketed from ALL stores, pruned ones included', async () => {
        const allRows = [
            row('oldquiet.com', '2026-05-13T01:40:42Z'),
            row('popular.com', '2026-05-13T01:40:42Z'),
            row('zeta.com', '2026-05-13T01:40:42Z'),
        ]
        repoMock.listStoreSitemapEntries.mockResolvedValue(allRows)
        const pruned = await sitemap()

        // The same rows with an empty prune list would emit these letters; the
        // 'o' page must exist although oldquiet.com is the only store under it.
        const letterPages = pruned
            .map(e => e.url)
            .filter(u => u.startsWith(`${ORIGIN}/coupons/stores`))
            .sort()
        expect(letterPages).toEqual([
            `${ORIGIN}/coupons/stores`,
            `${ORIGIN}/coupons/stores/o`,
            `${ORIGIN}/coupons/stores/p`,
            `${ORIGIN}/coupons/stores/z`,
        ])
        expect(storeUrls(pruned)).not.toContain(
            `${ORIGIN}/coupons/oldquiet.com`,
        )
    })

    it('emits every store when no row carries an age (the prune can only ever remove, never add)', async () => {
        repoMock.listStoreSitemapEntries.mockResolvedValue([
            row('oldquiet.com', undefined),
            row('popular.com', undefined),
        ])
        expect(storeUrls(await sitemap()).sort()).toEqual([
            `${ORIGIN}/coupons/oldquiet.com`,
            `${ORIGIN}/coupons/popular.com`,
        ])
    })
})

describe('sitemapStorePrune.data — the generated list is well formed', () => {
    it('is the real module (not the mocked fixture) via the source file', () => {
        const source = fs.readFileSync(
            path.join(process.cwd(), 'src/lib/seo/sitemapStorePrune.data.ts'),
            'utf8',
        )
        expect(source).toContain('T-15493')
        expect(source).toContain("SITEMAP_PRUNE_WINDOW_START = '2026-08-07'")
        const bases = Array.from(
            source.matchAll(/^\s+'([^']+)',$/gm),
            match => match[1]!,
        )
        expect(bases.length).toBeGreaterThan(0)

        // Sorted, unique, and each entry is its own canonical store base.
        expect(bases).toEqual([...bases].sort())
        expect(new Set(bases).size).toBe(bases.length)
        for (const base of bases) {
            expect(resolveStoreDomain(base), base).toBe(base)
        }
    })

    it('exports the mocked fixture shape the behaviour tests rely on (guards the mock against drifting from the real export names)', () => {
        expect(typeof SITEMAP_PRUNE_WINDOW_START).toBe('string')
        expect(Array.isArray(SITEMAP_PRUNE_BASES)).toBe(true)
    })
})

describe('the prune is wired into the sitemap and nowhere else — a pruned page stays live and indexable', () => {
    const SRC = path.join(process.cwd(), 'src')

    function sourceFiles(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) return sourceFiles(full)
            return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
        })
    }

    function importersOf(moduleSuffix: string): string[] {
        return sourceFiles(SRC)
            .filter(file =>
                new RegExp(`from '@/lib/seo/${moduleSuffix}'`).test(
                    fs.readFileSync(file, 'utf8'),
                ),
            )
            .map(file => path.relative(SRC, file).split(path.sep).join('/'))
    }

    it('is imported by src/app/sitemap.ts only (not robots.ts, storeIndexability.ts, the store page or the directory)', () => {
        expect(importersOf('sitemapStorePrune')).toEqual(['app/sitemap.ts'])
    })

    it('the generated list is read by the prune module only', () => {
        expect(importersOf('sitemapStorePrune\\.data')).toEqual([
            'lib/seo/sitemapStorePrune.ts',
        ])
    })
})
