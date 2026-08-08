import { listTopSites } from '@/lib/couponsRepo'
import Link from 'next/link'

// Server component — the only crawlable internal links to /coupons/[store]
// pages. The sitemap lists those pages but nothing on the site linked to them,
// and orphan pages rank poorly; this block closes that gap on /coupons and on
// every store page. Same read /api/sites/top-sites serves (LIMIT 4, most
// visible coupons first), so the counts shown are real catalog counts, never
// invented copy.
export default async function PopularStores({
    currentSite,
}: {
    currentSite?: string
}) {
    const rows = await listTopSites()
    const sites = rows.filter(
        (row): row is { site: string; coupon_count: number } =>
            Boolean(row.site) && row.site !== currentSite,
    )
    if (sites.length === 0) return null

    return (
        <section
            aria-labelledby="popular-stores-heading"
            className="mx-auto max-w-4xl pb-16"
        >
            <h2
                id="popular-stores-heading"
                className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
            >
                Popular coupon stores
            </h2>
            <ul className="flex flex-wrap gap-3">
                {sites.map(row => (
                    <li key={row.site}>
                        <Link
                            href={`/coupons/${encodeURIComponent(row.site)}`}
                            className="inline-flex items-center gap-2 rounded-full border border-gray-100 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm transition hover:border-orange-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:border-white/10 dark:bg-darkSurface dark:text-gray-100 dark:hover:border-orange-800/70 dark:focus-visible:ring-offset-darkSurface"
                        >
                            {row.site}
                            <span className="rounded-full bg-caramel/10 px-2 py-0.5 text-xs font-semibold text-caramel dark:bg-caramel/20">
                                {row.coupon_count}{' '}
                                {row.coupon_count === 1 ? 'code' : 'codes'}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    )
}
