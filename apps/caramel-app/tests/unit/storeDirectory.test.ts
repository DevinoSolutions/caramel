import type { StoreSitemapEntry } from '@/lib/seo/sitemapStores'
import {
    DIRECTORY_LETTERS,
    DIRECTORY_PAGE_SIZE,
    NEIGHBOUR_FETCH_LIMIT,
    NEIGHBOUR_STORE_COUNT,
    bucketStoresByLetter,
    directoryLetterLabel,
    directoryLetterOf,
    directoryPath,
    paginateDirectoryBucket,
    parseDirectoryLetter,
    parseDirectoryPage,
    pickNeighbourStores,
} from '@/lib/seo/storeDirectory'
import { describe, expect, it } from 'vitest'

// Pins the pure half of the A–Z store directory + neighbour links
// (src/lib/seo/storeDirectory.ts): letter bucketing, param parsing, page
// splitting and the neighbour window collapse. No DB, no env — the fixtures
// are the real prod slug shapes from the 2026-09-11 audit.

const d = (iso: string) => new Date(iso)
const entry = (base: string, couponCount = 1): StoreSitemapEntry => ({
    base,
    couponCount,
    lastModified: d('2026-09-01T00:00:00Z'),
})

describe('directoryLetterOf / parseDirectoryLetter / directoryLetterLabel', () => {
    it('buckets a base by its first character, digits and anything non a–z into 0-9', () => {
        expect(directoryLetterOf('michaels.com')).toBe('m')
        expect(directoryLetterOf('123ink.ca')).toBe('0-9')
        expect(directoryLetterOf('1-800-flowers.com')).toBe('0-9')
        // Defensive: resolveStoreDomain lowercases, but the bucket must not
        // depend on it.
        expect(directoryLetterOf('Brooklinen.com')).toBe('b')
        expect(directoryLetterOf('xn--bcher-kva.example')).toBe('x')
        expect(directoryLetterOf('-odd.com')).toBe('0-9')
    })

    it('accepts exactly the 27 directory letters (case-insensitively) and refuses everything else', () => {
        expect(DIRECTORY_LETTERS).toHaveLength(27)
        expect(DIRECTORY_LETTERS[0]).toBe('0-9')
        for (const letter of DIRECTORY_LETTERS) {
            expect(parseDirectoryLetter(letter)).toBe(letter)
        }
        expect(parseDirectoryLetter('M')).toBe('m')
        expect(parseDirectoryLetter(' m ')).toBe('m')
        for (const bad of [
            '',
            'zz',
            '0',
            '9',
            '0-9x',
            'é',
            'stores',
            'a.com',
        ]) {
            expect(parseDirectoryLetter(bad), bad).toBeNull()
        }
    })

    it('labels letters uppercase and the digit bucket as 0–9', () => {
        expect(directoryLetterLabel('m')).toBe('M')
        expect(directoryLetterLabel('0-9')).toBe('0–9')
    })
})

describe('parseDirectoryPage', () => {
    it('absent → page 1; a positive integer literal → that page', () => {
        expect(parseDirectoryPage(undefined)).toBe(1)
        expect(parseDirectoryPage('1')).toBe(1)
        expect(parseDirectoryPage('12')).toBe(12)
    })

    it('anything that is not a positive integer literal → null (the route 404s rather than guessing)', () => {
        for (const bad of ['0', '-1', '1.5', 'abc', '', ' 2', '02', '1e3']) {
            expect(parseDirectoryPage(bad), JSON.stringify(bad)).toBeNull()
        }
        expect(parseDirectoryPage(['1', '2'])).toBeNull()
    })
})

describe('directoryPath', () => {
    it('builds the index, letter and paged URLs from one place', () => {
        expect(directoryPath()).toBe('/coupons/stores')
        expect(directoryPath('m')).toBe('/coupons/stores/m')
        expect(directoryPath('0-9')).toBe('/coupons/stores/0-9')
        expect(directoryPath('m', 1)).toBe('/coupons/stores/m')
        expect(directoryPath('m', 2)).toBe('/coupons/stores/m?page=2')
    })
})

describe('bucketStoresByLetter', () => {
    it('groups entries by letter in DIRECTORY_LETTERS order, preserves the base-sorted input order inside each bucket, and omits empty letters entirely', () => {
        // Input is collapseStoreRows' output: already base-sorted. The
        // bucketing is a stable partition of that order, not a re-sort.
        const buckets = bucketStoresByLetter([
            entry('123ink.ca'),
            entry('barkevs.com'),
            entry('bobstores.com'),
            entry('brooklinen.com'),
            entry('michaels.com', 12),
        ])
        expect(buckets.map(b => b.letter)).toEqual(['0-9', 'b', 'm'])
        expect(buckets[1]!.stores.map(s => s.base)).toEqual([
            'barkevs.com',
            'bobstores.com',
            'brooklinen.com',
        ])
        expect(buckets[2]!.stores).toEqual([entry('michaels.com', 12)])
        // A letter with no stores is not a bucket (the route 404s it, the
        // sitemap and strips never link it).
        expect(buckets.find(b => b.letter === 'a')).toBeUndefined()
    })

    it('an empty catalog yields no buckets', () => {
        expect(bucketStoresByLetter([])).toEqual([])
    })
})

describe('paginateDirectoryBucket', () => {
    const many = Array.from({ length: DIRECTORY_PAGE_SIZE + 1 }, (_, i) =>
        entry(`b${String(i).padStart(4, '0')}.com`),
    )

    it('a bucket within DIRECTORY_PAGE_SIZE is one page holding everything', () => {
        const page = paginateDirectoryBucket(
            [entry('a.com'), entry('b.com')],
            1,
        )
        expect(page).toEqual({
            page: 1,
            pageCount: 1,
            stores: [entry('a.com'), entry('b.com')],
        })
    })

    it('one store past the cap splits into two pages; page 2 holds the remainder', () => {
        const first = paginateDirectoryBucket(many, 1)!
        const second = paginateDirectoryBucket(many, 2)!
        expect(first.pageCount).toBe(2)
        expect(first.stores).toHaveLength(DIRECTORY_PAGE_SIZE)
        expect(second.stores).toHaveLength(1)
        expect(second.stores[0]!.base).toBe('b0500.com')
        // No overlap, nothing lost.
        expect([...first.stores, ...second.stores]).toEqual(many)
    })

    it('an out-of-range page, page 0, a non-integer page, or ANY page of an empty bucket → null (404, never an empty page)', () => {
        expect(paginateDirectoryBucket(many, 3)).toBeNull()
        expect(paginateDirectoryBucket(many, 0)).toBeNull()
        expect(paginateDirectoryBucket(many, 1.5)).toBeNull()
        expect(paginateDirectoryBucket([], 1)).toBeNull()
    })

    it('honours an explicit page size', () => {
        const page = paginateDirectoryBucket(many.slice(0, 5), 2, 2)!
        expect(page.pageCount).toBe(3)
        expect(page.stores.map(s => s.base)).toEqual(['b0002.com', 'b0003.com'])
    })
})

describe('pickNeighbourStores', () => {
    const row = (site: string, coupon_count = 3) => ({
        site,
        coupon_count,
        last_updated: d('2026-09-01T00:00:00Z'),
    })

    it('over-fetches 3× the neighbour count so subdomain folds cannot starve a side', () => {
        expect(NEIGHBOUR_STORE_COUNT).toBe(5)
        expect(NEIGHBOUR_FETCH_LIMIT).toBe(15)
    })

    it('collapses each window to canonical bases, drops the current base and its own subdomain rows, keeps the nearest N per side, both ascending', () => {
        // Raw `site < 'gap.com' ORDER BY site DESC` window (nearest first),
        // as the repo returns it: includes a subdomain of the current store
        // (folds into gap.com → dropped) and a mixed-case twin pair.
        const before = [
            row('gaomon.com'),
            row('gamestop.com'),
            row('galaxus.ch'),
            row('g2a.com'),
            row('fye.com'),
            row('fujifilm.com'),
            row('freshly.com'),
            row('athleta.gap.com', 7),
        ]
        // Raw `site > 'gap.com' ORDER BY site ASC` window.
        const after = [
            row('gapfactory.com'),
            row('garmin.com'),
            row('gettyimages.com'),
            row('ghostbed.com'),
            row('giftcards.com'),
            row('glossier.com'),
            row('godaddy.com'),
            row('bananarepublic.gap.com', 4),
        ]

        const { previous, next } = pickNeighbourStores(
            { before, after },
            'gap.com',
            5,
        )
        expect(previous.map(e => e.base)).toEqual([
            'fye.com',
            'g2a.com',
            'galaxus.ch',
            'gamestop.com',
            'gaomon.com',
        ])
        expect(next.map(e => e.base)).toEqual([
            'gapfactory.com',
            'garmin.com',
            'gettyimages.com',
            'ghostbed.com',
            'giftcards.com',
        ])
        // Nearest-N: gaomon.com (adjacent) is in; fujifilm.com (6th nearest)
        // and freshly.com (7th) are out on the previous side.
        expect(previous.map(e => e.base)).not.toContain('fujifilm.com')
        expect(previous.map(e => e.base)).not.toContain('freshly.com')
        expect([...previous, ...next].some(e => e.base === 'gap.com')).toBe(
            false,
        )
    })

    it('a raw slug in one window that folds into a base already taken by the other side is not linked twice', () => {
        const { previous, next } = pickNeighbourStores(
            {
                before: [row('roborock.com')],
                after: [row('us.roborock.com'), row('rockauto.com')],
            },
            'robot-store.com',
            5,
        )
        expect(previous.map(e => e.base)).toEqual(['roborock.com'])
        expect(next.map(e => e.base)).toEqual(['rockauto.com'])
    })

    it('carries the real coupon count through (summed across folded slugs) and never links a zero-count or non-store row', () => {
        const { next } = pickNeighbourStores(
            {
                before: [],
                after: [
                    row('athleta.gap.com', 7),
                    row('gap.com', 30),
                    row('zero.com', 0),
                    row('co.uk', 50),
                ],
            },
            'fye.com',
            5,
        )
        expect(next).toEqual([
            {
                base: 'gap.com',
                couponCount: 37,
                lastModified: d('2026-09-01T00:00:00Z'),
            },
        ])
    })

    it('both windows empty (a one-store catalog) → no neighbours, no throw', () => {
        expect(
            pickNeighbourStores({ before: [], after: [] }, 'only.com'),
        ).toEqual({ previous: [], next: [] })
    })
})
