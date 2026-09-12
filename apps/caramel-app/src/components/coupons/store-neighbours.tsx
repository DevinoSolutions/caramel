import { listNeighbourStoreRows } from '@/lib/couponsRepo'
import type { StoreSitemapEntry } from '@/lib/seo/sitemapStores'
import {
    NEIGHBOUR_FETCH_LIMIT,
    NEIGHBOUR_STORE_COUNT,
    directoryLetterLabel,
    directoryLetterOf,
    directoryPath,
    pickNeighbourStores,
} from '@/lib/seo/storeDirectory'

// Server component — the "More stores" section on every /coupons/[store]
// page: the 5 indexable stores alphabetically before and after this one, plus
// the directory letter page this store lives on. Together with the directory
// this turns the catalog into one crawl chain (every store page reaches its
// neighbours, every neighbour reaches the next) instead of ~4,262 sitemap-only
// orphans linked from nowhere (audit 2026-09-11). PopularStores stays beside
// it: that block links the 4 biggest stores, this one links the nearest.
//
// Real data only: the coupon count on each chip is the live visible count the
// sitemap uses. Plain <a> rather than next/link — see store-letter-strip.tsx.
export default async function StoreNeighbours({ base }: { base: string }) {
    // No base = the slug names no registrable store (the page's noindexed
    // empty state); there is no alphabetical position to link around.
    if (!base) return null

    const rows = await listNeighbourStoreRows(base, NEIGHBOUR_FETCH_LIMIT)
    const { previous, next } = pickNeighbourStores(
        rows,
        base,
        NEIGHBOUR_STORE_COUNT,
    )
    const letter = directoryLetterOf(base)
    // previous… ‹this store› …next — one alphabetical run.
    const neighbours: StoreSitemapEntry[] = [...previous, ...next]

    return (
        <section
            aria-labelledby="more-stores-heading"
            className="mx-auto max-w-4xl pb-16"
        >
            <h2
                id="more-stores-heading"
                className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
            >
                More stores
            </h2>
            {neighbours.length > 0 ? (
                <ul className="flex flex-wrap gap-3">
                    {neighbours.map(store => (
                        <li key={store.base}>
                            <a
                                href={`/coupons/${encodeURIComponent(store.base)}`}
                                className="inline-flex items-center gap-2 rounded-full border border-gray-100 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm transition hover:border-orange-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:border-white/10 dark:bg-darkSurface dark:text-gray-100 dark:hover:border-orange-800/70 dark:focus-visible:ring-offset-darkSurface"
                            >
                                {store.base}
                                <span className="rounded-full bg-caramel/10 px-2 py-0.5 text-xs font-semibold text-caramel dark:bg-caramel/20">
                                    {store.couponCount.toLocaleString('en-US')}{' '}
                                    {store.couponCount === 1 ? 'code' : 'codes'}
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            ) : null}
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                <a
                    href={directoryPath(letter)}
                    className="font-semibold text-caramel underline-offset-2 hover:underline"
                >
                    All stores starting with {directoryLetterLabel(letter)}
                </a>
                {' · '}
                <a
                    href={directoryPath()}
                    className="font-semibold text-caramel underline-offset-2 hover:underline"
                >
                    Store directory A–Z
                </a>
            </p>
        </section>
    )
}
