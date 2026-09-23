import type { DirectoryLetter } from '@/lib/seo/storeDirectory'
import {
    bucketStoresByLetter,
    directoryLetterLabel,
    directoryPath,
} from '@/lib/seo/storeDirectory'
import { getStoreDirectoryEntries } from '@/lib/seo/storeDirectoryCache'

// Server component — the "Browse stores A–Z" strip on /coupons,
// /supported-stores and the directory pages. It links ONLY the letters that
// currently have indexable stores (a letter with none is a 404), read from the
// same cached, sitemap-identical list the directory pages render.
//
// Plain <a>, not next/link: this strip sits on the busiest marketing pages and
// next/link would prefetch up to 27 force-dynamic routes per view for links a
// crawler cares about far more than a shopper does.
export default async function StoreLetterStrip({
    current,
}: {
    /** The letter page being rendered, if any — marked aria-current, not linked. */
    current?: DirectoryLetter
}) {
    const buckets = bucketStoresByLetter(await getStoreDirectoryEntries())
    if (buckets.length === 0) return null

    return (
        <nav aria-label="Browse stores A–Z" className="mx-auto max-w-4xl pb-16">
            <h2 className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Browse stores A–Z
            </h2>
            <ul className="flex flex-wrap gap-2 [&>li>a[aria-current]]:bg-caramel [&>li>a[aria-current]]:text-white [&>li>a]:inline-flex [&>li>a]:min-w-10 [&>li>a]:justify-center [&>li>a]:rounded-full [&>li>a]:border [&>li>a]:border-gray-100 [&>li>a]:bg-white [&>li>a]:px-3 [&>li>a]:py-1.5 [&>li>a]:text-sm [&>li>a]:font-semibold [&>li>a]:text-gray-800 [&>li>a]:shadow-sm [&>li>a]:transition hover:[&>li>a]:border-orange-200 hover:[&>li>a]:shadow-md focus-visible:[&>li>a]:outline-none focus-visible:[&>li>a]:ring-2 focus-visible:[&>li>a]:ring-caramel dark:[&>li>a]:border-white/10 dark:[&>li>a]:bg-darkSurface dark:[&>li>a]:text-gray-100">
                {buckets.map(bucket => (
                    <li key={bucket.letter}>
                        <a
                            href={directoryPath(bucket.letter)}
                            aria-current={
                                bucket.letter === current ? 'page' : undefined
                            }
                            title={`${bucket.stores.length.toLocaleString('en-US')} stores`}
                        >
                            {directoryLetterLabel(bucket.letter)}
                        </a>
                    </li>
                ))}
                <li>
                    <a href={directoryPath()}>All stores</a>
                </li>
            </ul>
        </nav>
    )
}
