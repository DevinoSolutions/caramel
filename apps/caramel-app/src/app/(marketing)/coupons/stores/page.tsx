import StoreLetterStrip from '@/components/coupons/store-letter-strip'
import { BASE_URL } from '@/lib/env.client'
import { jsonLdString } from '@/lib/jsonLd'
import {
    bucketStoresByLetter,
    directoryLetterLabel,
    directoryPath,
} from '@/lib/seo/storeDirectory'
import { getStoreDirectoryEntries } from '@/lib/seo/storeDirectoryCache'
import type { Metadata } from 'next'

// The A–Z store directory index: one link per letter that has indexable
// stores, with real counts. Reads the coupon catalog, and the production
// image builds against an unreachable placeholder DATABASE_URL (Dockerfile
// `.invalid` builder env) — so per-request, never prerendered, like
// /coupons and sitemap.ts.
export const dynamic = 'force-dynamic'

const baseUrl = BASE_URL.replace(/\/+$/, '')
const title = 'All stores with coupon codes A–Z | Caramel'
const description =
    'Every store Caramel has live coupon codes for, listed A to Z. Pick a letter to browse stores and their current promo codes.'
const canonical = `${baseUrl}${directoryPath()}`
const banner = `${baseUrl}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
        type: 'website',
        url: canonical,
        title,
        description,
        locale: 'en_US',
        siteName: 'Caramel',
        images: [{ url: banner, width: 1200, height: 630 }],
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title,
        description,
        images: [banner],
    },
}

export default async function StoreDirectoryIndexPage() {
    const entries = await getStoreDirectoryEntries()
    const buckets = bucketStoresByLetter(entries)
    const storeCount = entries.length

    const breadcrumbData = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
            {
                '@type': 'ListItem',
                position: 2,
                name: 'Coupons',
                item: `${baseUrl}/coupons`,
            },
            { '@type': 'ListItem', position: 3, name: 'All stores A–Z' },
        ],
    }

    return (
        <main className="relative min-h-screen px-6 pt-32 dark:bg-darkBg lg:px-8">
            <header className="mx-auto max-w-4xl pb-10">
                <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-gray-900 dark:text-white md:text-3xl">
                    All stores with coupon codes, A–Z
                </h1>
                <p className="leading-relaxed text-gray-600 dark:text-gray-400">
                    {storeCount > 0
                        ? `Caramel currently lists live coupon codes for ${storeCount.toLocaleString('en-US')} ${storeCount === 1 ? 'store' : 'stores'}. Pick a letter to see every store that starts with it and how many codes each one has right now.`
                        : 'Caramel has no stores with live coupon codes right now — new codes are added automatically as they are found.'}
                </p>
            </header>
            <StoreLetterStrip />
            {buckets.length > 0 ? (
                <section
                    aria-labelledby="letters-heading"
                    className="mx-auto max-w-4xl pb-24"
                >
                    <h2
                        id="letters-heading"
                        className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
                    >
                        Stores by first letter
                    </h2>
                    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-2 [&>li>a]:flex [&>li>a]:items-baseline [&>li>a]:justify-between [&>li>a]:rounded-2xl [&>li>a]:border [&>li>a]:border-gray-100 [&>li>a]:bg-white [&>li>a]:px-4 [&>li>a]:py-3 [&>li>a]:shadow-sm [&>li>a]:transition hover:[&>li>a]:border-orange-200 hover:[&>li>a]:shadow-md dark:[&>li>a]:border-white/10 dark:[&>li>a]:bg-darkSurface">
                        {buckets.map(bucket => (
                            <li key={bucket.letter}>
                                <a href={directoryPath(bucket.letter)}>
                                    <span className="text-lg font-bold text-gray-900 dark:text-white">
                                        {directoryLetterLabel(bucket.letter)}
                                    </span>
                                    <span className="text-sm text-gray-600 dark:text-gray-400">
                                        {bucket.stores.length.toLocaleString(
                                            'en-US',
                                        )}{' '}
                                        {bucket.stores.length === 1
                                            ? 'store'
                                            : 'stores'}
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(breadcrumbData),
                }}
            />
        </main>
    )
}
