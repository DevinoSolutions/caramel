import StoreDirectoryLetterPage, {
    generateMetadata,
} from '@/app/(marketing)/coupons/stores/[letter]/page'
import StoreDirectoryIndexPage, {
    metadata as indexMetadata,
} from '@/app/(marketing)/coupons/stores/page'
import StoreLetterStrip from '@/components/coupons/store-letter-strip'
import StoreNeighbours from '@/components/coupons/store-neighbours'
import { BASE_URL } from '@/lib/env.client'
import { DIRECTORY_PAGE_SIZE } from '@/lib/seo/storeDirectory'
import { resetStoreDirectoryCache } from '@/lib/seo/storeDirectoryCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The A–Z store directory routes + the two server components that link into
// it, exercised the way coupons-store-page.test.ts exercises the store page:
// `@/lib/prisma` mocked with a rule-based `$queryRaw` keyed on the composed
// `.sql`, the default exports called directly, the returned (unrendered)
// element tree inspected. The directory read goes through the in-process
// cache, so it is reset before every case.
//
// Rule order matters: the neighbour windows also contain `GROUP BY site`, so
// they are matched on their `site < ?` / `site > ?` predicates FIRST.

type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
    },
}))

const origin = BASE_URL.replace(/\/+$/, '')
const isDirectoryRead = (sql: string) =>
    sql.includes('GROUP BY site') &&
    !sql.includes('site < ?') &&
    !sql.includes('site > ?')

const aggregateRow = (site: string, coupon_count = 3) => ({
    site,
    coupon_count,
    last_updated: '2026-09-01T00:00:00.000Z',
})

// Real prod shapes: a subdomain slug that folds into gap.com, a mixed-case
// twin, a digit-leading store, a non-store and a zero-count row (both dropped).
const CATALOG = [
    aggregateRow('123ink.ca', 25),
    aggregateRow('athleta.gap.com', 7),
    aggregateRow('Brooklinen.com', 2),
    aggregateRow('brooklinen.com', 9),
    aggregateRow('co.uk', 50),
    aggregateRow('gap.com', 30),
    aggregateRow('michaels.com', 12),
    aggregateRow('zero.com', 0),
]

function tree(el: unknown): string {
    return JSON.stringify(el)
}

beforeEach(() => {
    rules = []
    resetStoreDirectoryCache()
})

describe('/coupons/stores — directory index', () => {
    it('metadata: the A–Z title, a self canonical, index+follow', () => {
        expect(indexMetadata.title).toBe(
            'All stores with coupon codes A–Z | Caramel',
        )
        expect(indexMetadata.alternates?.canonical).toBe(
            `${origin}/coupons/stores`,
        )
        expect(indexMetadata.robots).toEqual({ index: true, follow: true })
    })

    it('links every letter that has stores with its real store count, and no letter without', async () => {
        mockRows(isDirectoryRead, CATALOG)
        const html = tree(await StoreDirectoryIndexPage())

        // 123ink.ca → 0-9; brooklinen.com → b; gap.com (athleta folded) → g;
        // michaels.com → m. co.uk and zero.com are not stores.
        for (const letter of ['0-9', 'b', 'g', 'm']) {
            expect(html).toContain(`"href":"/coupons/stores/${letter}"`)
        }
        for (const letter of ['a', 'c', 'z']) {
            expect(html).not.toContain(`"href":"/coupons/stores/${letter}"`)
        }
        // Counts are the collapsed catalog's, stated on the page.
        expect(html).toContain('4 stores')
        expect(html).not.toContain('co.uk')
        expect(html).not.toContain('zero.com')
    })
})

describe('/coupons/stores/[letter] — generateMetadata', () => {
    it('a letter with stores: "Stores starting with X" title, un-paged self canonical, index+follow', async () => {
        mockRows(isDirectoryRead, CATALOG)
        const metadata = await generateMetadata({ params: { letter: 'b' } })
        expect(metadata.title).toBe(
            'Stores starting with B — coupon codes | Caramel',
        )
        expect(metadata.alternates?.canonical).toBe(
            `${origin}/coupons/stores/b`,
        )
        expect(metadata.robots).toEqual({ index: true, follow: true })
        expect(metadata.openGraph?.url).toBe(`${origin}/coupons/stores/b`)
    })

    it('the digit bucket is labelled 0–9 and canonicalizes to /coupons/stores/0-9', async () => {
        mockRows(isDirectoryRead, CATALOG)
        const metadata = await generateMetadata({ params: { letter: '0-9' } })
        expect(metadata.title).toBe(
            'Stores starting with 0–9 — coupon codes | Caramel',
        )
        expect(metadata.alternates?.canonical).toBe(
            `${origin}/coupons/stores/0-9`,
        )
    })

    it('an uppercase param resolves to the lowercase letter and canonicalizes there', async () => {
        mockRows(isDirectoryRead, CATALOG)
        const metadata = await generateMetadata({ params: { letter: 'M' } })
        expect(metadata.alternates?.canonical).toBe(
            `${origin}/coupons/stores/m`,
        )
    })

    it('a letter with NO stores is notFound() — never an empty indexable page', async () => {
        mockRows(isDirectoryRead, CATALOG)
        await expect(
            generateMetadata({ params: { letter: 'q' } }),
        ).rejects.toMatchObject({ digest: expect.stringContaining('404') })
        await expect(
            StoreDirectoryLetterPage({ params: { letter: 'q' } }),
        ).rejects.toMatchObject({ digest: expect.stringContaining('404') })
    })

    it('a param that is not a directory letter is notFound()', async () => {
        mockRows(isDirectoryRead, CATALOG)
        for (const bad of ['zz', 'stores', 'gap.com', '']) {
            await expect(
                generateMetadata({ params: { letter: bad } }),
                bad,
            ).rejects.toMatchObject({ digest: expect.stringContaining('404') })
        }
    })

    it('an empty catalog makes every letter notFound()', async () => {
        mockRows(isDirectoryRead, [])
        await expect(
            generateMetadata({ params: { letter: 'b' } }),
        ).rejects.toMatchObject({ digest: expect.stringContaining('404') })
    })
})

describe('/coupons/stores/[letter] — body', () => {
    it("lists ONLY that letter's canonical stores as /coupons/<base> links with their live counts, and marks the letter in the strip", async () => {
        mockRows(isDirectoryRead, CATALOG)
        const html = tree(
            await StoreDirectoryLetterPage({ params: { letter: 'b' } }),
        )

        // JSX keeps interpolated text as separate children.
        expect(html).toContain('"children":["Stores starting with ","B"]')
        expect(html).toContain('"href":"/coupons/brooklinen.com"')
        // Mixed-case twin folded: one link, summed count.
        expect(html).not.toContain('Brooklinen.com')
        expect(html).toContain('· 11 codes')
        // Other letters' stores are not on this page.
        expect(html).not.toContain('"href":"/coupons/gap.com"')
        expect(html).not.toContain('"href":"/coupons/michaels.com"')
        expect(html).not.toContain('"href":"/coupons/123ink.ca"')
        // The strip is told which letter it is on.
        expect(html).toContain('"current":"b"')
        // No pagination nav for a single page.
        expect(html).not.toContain('Next page')
        // Breadcrumbs point back at the directory index.
        expect(html).toContain(`${origin}/coupons/stores`)
    })

    it('a letter whose store count exceeds DIRECTORY_PAGE_SIZE splits: page 2 is noindex+follow, canonicalizes to page 1, and links back', async () => {
        const many = Array.from({ length: DIRECTORY_PAGE_SIZE + 1 }, (_, i) =>
            aggregateRow(`b${String(i).padStart(4, '0')}.com`),
        )
        mockRows(isDirectoryRead, many)

        const page1 = await generateMetadata({
            params: { letter: 'b' },
            searchParams: {},
        })
        expect(page1.robots).toEqual({ index: true, follow: true })

        const page2 = await generateMetadata({
            params: { letter: 'b' },
            searchParams: Promise.resolve({ page: '2' }),
        })
        expect(page2.robots).toEqual({ index: false, follow: true })
        expect(page2.alternates?.canonical).toBe(`${origin}/coupons/stores/b`)

        const html = tree(
            await StoreDirectoryLetterPage({
                params: { letter: 'b' },
                searchParams: { page: '2' },
            }),
        )
        expect(html).toContain('Page 2 of 2')
        expect(html).toContain('"href":"/coupons/b0500.com"')
        expect(html).not.toContain('"href":"/coupons/b0499.com"')
        expect(html).toContain('"href":"/coupons/stores/b"')
        expect(html).toContain('"rel":"prev"')
        expect(html).not.toContain('"rel":"next"')

        const first = tree(
            await StoreDirectoryLetterPage({ params: { letter: 'b' } }),
        )
        expect(first).toContain('"href":"/coupons/stores/b?page=2"')
        expect(first).toContain('"rel":"next"')
    })

    it('a page past the end or a malformed ?page= is notFound()', async () => {
        mockRows(isDirectoryRead, CATALOG)
        for (const page of ['2', '0', 'abc', '1.5']) {
            await expect(
                generateMetadata({
                    params: { letter: 'b' },
                    searchParams: { page },
                }),
                page,
            ).rejects.toMatchObject({ digest: expect.stringContaining('404') })
        }
    })
})

describe('StoreLetterStrip — "Browse stores A–Z"', () => {
    it('renders a link per letter that has stores, aria-current on the current one, plus the index link; null on an empty catalog', async () => {
        mockRows(isDirectoryRead, CATALOG)
        const html = tree(await StoreLetterStrip({ current: 'g' }))
        expect(html).toContain('Browse stores A–Z')
        expect(html).toContain('"href":"/coupons/stores/0-9"')
        expect(html).toContain('"href":"/coupons/stores/b"')
        expect(html).toContain(
            '"href":"/coupons/stores/g","aria-current":"page"',
        )
        expect(html).toContain('"href":"/coupons/stores/m"')
        expect(html).not.toContain('"href":"/coupons/stores/a"')
        expect(html).toContain('"href":"/coupons/stores"')

        resetStoreDirectoryCache()
        rules = []
        mockRows(isDirectoryRead, [])
        expect(await StoreLetterStrip({})).toBeNull()
    })
})

describe('StoreNeighbours — "More stores" on a store page', () => {
    it('links the nearest indexable stores on both sides (never itself), with live counts, plus its letter page and the index', async () => {
        mockRows(
            sql => sql.includes('site < ?'),
            [
                aggregateRow('gaomon.com', 4),
                aggregateRow('gamestop.com', 8),
                aggregateRow('athleta.gap.com', 7),
            ],
        )
        mockRows(
            sql => sql.includes('site > ?'),
            [aggregateRow('gapfactory.com', 1), aggregateRow('garmin.com', 5)],
        )

        const html = tree(await StoreNeighbours({ base: 'gap.com' }))
        expect(html).toContain('More stores')
        expect(html).toContain('"href":"/coupons/gamestop.com"')
        expect(html).toContain('"href":"/coupons/gaomon.com"')
        expect(html).toContain('"href":"/coupons/gapfactory.com"')
        expect(html).toContain('"href":"/coupons/garmin.com"')
        expect(html).not.toContain('"href":"/coupons/gap.com"')
        expect(html).not.toContain('athleta.gap.com')
        expect(html).toContain('"1"," ","code"')
        expect(html).toContain('"href":"/coupons/stores/g"')
        expect(html).toContain('"children":["All stores starting with ","G"]')
        expect(html).toContain('"href":"/coupons/stores"')
    })

    it('renders nothing for a slug that names no store (no alphabetical position to link around)', async () => {
        expect(await StoreNeighbours({ base: '' })).toBeNull()
    })

    it('with no neighbours at all it still links the letter page (the directory is the fallback path)', async () => {
        const html = tree(await StoreNeighbours({ base: '123ink.ca' }))
        expect(html).toContain('"href":"/coupons/stores/0-9"')
        expect(html).toContain('"children":["All stores starting with ","0–9"]')
        // No neighbour list at all — not an empty <ul>.
        expect(html).not.toContain('"type":"ul"')
        expect(html).not.toContain('"href":"/coupons/123ink.ca"')
    })
})
