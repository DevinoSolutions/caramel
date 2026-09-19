// src/lib/seo/storeDirectory.ts
//
// The A–Z store directory (/coupons/stores, /coupons/stores/[letter]) and the
// per-store "More stores" neighbour links exist for ONE reason: crawl
// discovery. On 2026-09-11 grabcaramel.com had ~4,262 canonical
// /coupons/<store> pages and only 8 of them had any internal inbound link (the
// 4-item "Popular coupon stores" block, identical on every page, plus 8 tiles
// on /supported-stores). GSC knew 4,289 of 4,317 sitemap URLs as "unknown" —
// orphan pages are neither crawled nor ranked, and a sitemap alone is not a
// discovery mechanism Google trusts here. See
// caramel-artifact/seo-2026-09-11/audit-findings.md §Interlinking.
//
// Everything in this module is pure (no DB, no env, no I/O) and operates on
// the SAME collapsed entries the sitemap emits (sitemapStores.collapseStoreRows
// over couponsRepo.listStoreSitemapEntries), so the directory and the sitemap
// can never disagree about which stores exist or which are indexable.
import type {
    StoreSitemapEntry,
    StoreSitemapRow,
} from '@/lib/seo/sitemapStores'
import { collapseStoreRows } from '@/lib/seo/sitemapStores'

/** Every directory bucket, in display order. `0-9` covers bases whose first character is not a–z. */
export const DIRECTORY_LETTERS = [
    '0-9',
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
] as const
export type DirectoryLetter = (typeof DIRECTORY_LETTERS)[number]

/**
 * Stores per letter page before `?page=N` splitting kicks in. Measured on the
 * dev catalog 2026-09-12 (4,124 store slugs): b 425, c 400, s 367, a 313 —
 * every letter fits on one page today, but `b` sits at 85% of this cap and the
 * catalog grows, so the split is wired rather than deferred. 500 keeps the
 * biggest possible page's HTML (list + its RSC payload twin) near 150 KB.
 */
export const DIRECTORY_PAGE_SIZE = 500

/** Neighbour links per direction on a store page ("More stores"). */
export const NEIGHBOUR_STORE_COUNT = 5

/**
 * Raw rows to fetch per direction for NEIGHBOUR_STORE_COUNT neighbours. The
 * neighbour queries walk RAW `coupons.site` order, and a raw slug can fold into
 * a base already listed (athleta.gap.com → gap.com) or into the current base
 * itself — so over-fetch, collapse, then trim. 84 of 4,311 prod slugs were
 * subdomains (2%); 3× is generous.
 */
export const NEIGHBOUR_FETCH_LIMIT = NEIGHBOUR_STORE_COUNT * 3

const DIRECTORY_PATH = '/coupons/stores'

/** The bucket a canonical base lands in: its first character, digits (and anything else non a–z) → '0-9'. */
export function directoryLetterOf(base: string): DirectoryLetter {
    const first = base.trim().charAt(0).toLowerCase()
    return first >= 'a' && first <= 'z' ? (first as DirectoryLetter) : '0-9'
}

/** `/coupons/stores/[letter]` param → bucket, or null for anything that is not exactly one of DIRECTORY_LETTERS (case-insensitive). */
export function parseDirectoryLetter(raw: string): DirectoryLetter | null {
    const letter = raw.trim().toLowerCase()
    return (DIRECTORY_LETTERS as ReadonlyArray<string>).includes(letter)
        ? (letter as DirectoryLetter)
        : null
}

/** Human label: 'B', or '0–9' for the digit bucket. */
export function directoryLetterLabel(letter: DirectoryLetter): string {
    return letter === '0-9' ? '0–9' : letter.toUpperCase()
}

/**
 * `?page=` → 1-based page number. Absent → 1. Anything that is not a positive
 * integer literal (`0`, `-1`, `1.5`, `abc`, a repeated param) → null, which the
 * route turns into a 404 rather than guessing.
 */
export function parseDirectoryPage(
    raw: string | string[] | undefined,
): number | null {
    if (raw === undefined) return 1
    if (typeof raw !== 'string') return null
    if (!/^[1-9][0-9]*$/.test(raw)) return null
    const page = Number(raw)
    return Number.isSafeInteger(page) ? page : null
}

/** Directory URL paths — one place, so links, canonicals and the sitemap agree. */
export function directoryPath(letter?: DirectoryLetter, page = 1): string {
    if (!letter) return DIRECTORY_PATH
    const path = `${DIRECTORY_PATH}/${letter}`
    return page > 1 ? `${path}?page=${page}` : path
}

export type DirectoryBucket = {
    letter: DirectoryLetter
    /** Sorted by base — collapseStoreRows' order, preserved. */
    stores: StoreSitemapEntry[]
}

/**
 * Group collapsed entries by directory letter. Only NON-EMPTY buckets are
 * returned, in DIRECTORY_LETTERS order — a letter with no stores must be a
 * 404, never an empty page, and must not be linked or sitemapped.
 */
export function bucketStoresByLetter(
    entries: ReadonlyArray<StoreSitemapEntry>,
): DirectoryBucket[] {
    const byLetter = new Map<DirectoryLetter, StoreSitemapEntry[]>()
    for (const entry of entries) {
        const letter = directoryLetterOf(entry.base)
        const bucket = byLetter.get(letter)
        if (bucket) bucket.push(entry)
        else byLetter.set(letter, [entry])
    }
    return DIRECTORY_LETTERS.flatMap(letter => {
        const stores = byLetter.get(letter)
        return stores && stores.length > 0 ? [{ letter, stores }] : []
    })
}

export type DirectoryPage = {
    page: number
    pageCount: number
    stores: StoreSitemapEntry[]
}

/**
 * The slice of a bucket shown on page N (1-based). Returns null when the page
 * is out of range — including page 1 of an empty bucket — so the route can
 * 404. Page 1 is the un-paged URL; pages > 1 carry `?page=N`, canonicalize to
 * page 1 and are `noindex, follow` (the route owns those rules).
 */
export function paginateDirectoryBucket(
    stores: ReadonlyArray<StoreSitemapEntry>,
    page: number,
    pageSize: number = DIRECTORY_PAGE_SIZE,
): DirectoryPage | null {
    if (stores.length === 0) return null
    const pageCount = Math.ceil(stores.length / pageSize)
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return null
    const start = (page - 1) * pageSize
    return { page, pageCount, stores: stores.slice(start, start + pageSize) }
}

export type NeighbourStoreRows = {
    /** Raw aggregate rows with `site < base`, nearest first (ORDER BY site DESC). */
    before: ReadonlyArray<StoreSitemapRow>
    /** Raw aggregate rows with `site > base`, nearest first (ORDER BY site ASC). */
    after: ReadonlyArray<StoreSitemapRow>
}

export type NeighbourStores = {
    /** Up to `count` indexable bases alphabetically before `base`, ascending. */
    previous: StoreSitemapEntry[]
    /** Up to `count` indexable bases alphabetically after `base`, ascending. */
    next: StoreSitemapEntry[]
}

/**
 * Collapse the two raw neighbour windows to canonical bases (same collapse +
 * indexability policy as the sitemap), drop the current base (its own
 * subdomain rows fold into it) and any base already taken by the other side,
 * then keep the `count` nearest per side. Both lists come back ascending so
 * the page reads as one alphabetical run: previous… ‹current› …next.
 */
export function pickNeighbourStores(
    rows: NeighbourStoreRows,
    base: string,
    count: number = NEIGHBOUR_STORE_COUNT,
): NeighbourStores {
    const previous = collapseStoreRows(rows.before)
        .filter(entry => entry.base !== base)
        .slice(-count)
    const taken = new Set(previous.map(entry => entry.base))
    const next = collapseStoreRows(rows.after)
        .filter(entry => entry.base !== base && !taken.has(entry.base))
        .slice(0, count)
    return { previous, next }
}
