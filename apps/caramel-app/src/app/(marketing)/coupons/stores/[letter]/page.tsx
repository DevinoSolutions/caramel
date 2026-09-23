import StoreLetterStrip from '@/components/coupons/store-letter-strip'
import { BASE_URL } from '@/lib/env.client'
import { jsonLdString } from '@/lib/jsonLd'
import type { DirectoryLetter, DirectoryPage } from '@/lib/seo/storeDirectory'
import {
    bucketStoresByLetter,
    directoryLetterLabel,
    directoryPath,
    paginateDirectoryBucket,
    parseDirectoryLetter,
    parseDirectoryPage,
} from '@/lib/seo/storeDirectory'
import { getStoreDirectoryEntries } from '@/lib/seo/storeDirectoryCache'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'

// One letter of the A–Z store directory: a server-rendered list of
// `<a href="/coupons/<base>">` for every indexable store whose canonical base
// starts with that letter, with its live coupon count. This is the crawl path
// into the store pages (see src/lib/seo/storeDirectory.ts for why).
//
// Reads the catalog → per-request, never prerendered (same constraint as
// /coupons and sitemap.ts: the production image builds against an
// unreachable placeholder DATABASE_URL).
export const dynamic = 'force-dynamic'

const baseUrl = BASE_URL.replace(/\/+$/, '')

type LetterParams = { letter: string }
type LetterSearchParams = Record<string, string | string[] | undefined>

type ResolvedLetterPage = {
    letter: DirectoryLetter
    page: DirectoryPage
}

// cache(): generateMetadata and the body both need the resolved page, and
// React request-level caching makes that ONE lookup (the underlying catalog
// read is itself cached in storeDirectoryCache). Any invalid input — a param
// that is not a directory letter, a `?page=` that is not a positive integer,
// a page past the end, or a letter with no stores — is `notFound()`: a letter
// with zero stores must be a 404, never an empty page.
const resolveLetterPage = cache(
    async (
        rawLetter: string,
        rawPage: string | string[] | undefined,
    ): Promise<ResolvedLetterPage> => {
        const letter = parseDirectoryLetter(rawLetter)
        const pageNumber = parseDirectoryPage(rawPage)
        if (!letter || pageNumber === null) notFound()

        const buckets = bucketStoresByLetter(await getStoreDirectoryEntries())
        const bucket = buckets.find(b => b.letter === letter)
        const page = bucket
            ? paginateDirectoryBucket(bucket.stores, pageNumber)
            : null
        if (!page) notFound()

        return { letter, page }
    },
)

async function resolveInput(input: {
    params: Promise<LetterParams> | LetterParams
    searchParams?: Promise<LetterSearchParams> | LetterSearchParams
}): Promise<ResolvedLetterPage> {
    const { letter } = await Promise.resolve(input.params)
    const search = (await Promise.resolve(input.searchParams)) ?? {}
    return resolveLetterPage(
        typeof letter === 'string' ? letter : '',
        search.page,
    )
}

export async function generateMetadata(input: {
    params: Promise<LetterParams> | LetterParams
    searchParams?: Promise<LetterSearchParams> | LetterSearchParams
}): Promise<Metadata> {
    const { letter, page } = await resolveInput(input)
    const label = directoryLetterLabel(letter)
    const title = `Stores starting with ${label} — coupon codes | Caramel`
    const description = `Browse every store starting with ${label} that Caramel has live coupon codes for, with the number of codes available at each one right now.`
    // Canonical is ALWAYS the un-paged letter URL: a split letter's later
    // pages are continuation, not distinct answers, so they point at page 1
    // and stay out of the index (still followed — their store links are the
    // whole point). Page 1 is index, follow.
    const canonical = `${baseUrl}${directoryPath(letter)}`
    const banner = `${baseUrl}/caramel_banner.png`

    return {
        title,
        description,
        alternates: { canonical },
        robots:
            page.page > 1
                ? { index: false, follow: true }
                : { index: true, follow: true },
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
}

export default async function StoreDirectoryLetterPage(input: {
    params: Promise<LetterParams> | LetterParams
    searchParams?: Promise<LetterSearchParams> | LetterSearchParams
}) {
    const { letter, page } = await resolveInput(input)
    const label = directoryLetterLabel(letter)
    const total = page.stores.length
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
            {
                '@type': 'ListItem',
                position: 3,
                name: 'All stores A–Z',
                item: `${baseUrl}${directoryPath()}`,
            },
            { '@type': 'ListItem', position: 4, name: `Stores: ${label}` },
        ],
    }

    return (
        <main className="relative min-h-screen px-6 pt-32 dark:bg-darkBg lg:px-8">
            <header className="mx-auto max-w-4xl pb-10">
                <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-gray-900 dark:text-white md:text-3xl">
                    Stores starting with {label}
                </h1>
                <p className="leading-relaxed text-gray-600 dark:text-gray-400">
                    {page.pageCount > 1
                        ? `Page ${page.page} of ${page.pageCount}. `
                        : ''}
                    {`${total.toLocaleString('en-US')} ${total === 1 ? 'store' : 'stores'} with live coupon codes${page.pageCount > 1 ? ' on this page' : ''}. Each link opens that store's current codes.`}
                </p>
            </header>
            <StoreLetterStrip current={letter} />
            {/* Deliberately lean markup: this list can hold up to
                DIRECTORY_PAGE_SIZE stores and every byte here ships twice (HTML
                + the RSC payload), so styling lives on the <ul> via child
                selectors and each item is a bare <li><a>base</a> · N codes</li>.
                Plain <a>, not next/link — see store-letter-strip.tsx. */}
            <section
                aria-labelledby="stores-heading"
                className="mx-auto max-w-4xl pb-24"
            >
                <h2
                    id="stores-heading"
                    className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
                >
                    {label} stores with coupon codes
                </h2>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-gray-600 dark:text-gray-400 sm:grid-cols-1 [&>li>a]:font-semibold [&>li>a]:text-gray-900 [&>li>a]:underline-offset-2 hover:[&>li>a]:text-caramel hover:[&>li>a]:underline dark:[&>li>a]:text-white">
                    {page.stores.map(store => (
                        <li key={store.base}>
                            <a
                                href={`/coupons/${encodeURIComponent(store.base)}`}
                            >
                                {store.base}
                            </a>
                            {` · ${store.couponCount.toLocaleString('en-US')} ${store.couponCount === 1 ? 'code' : 'codes'}`}
                        </li>
                    ))}
                </ul>
                {page.pageCount > 1 ? (
                    <nav
                        aria-label="Pagination"
                        className="mt-8 flex items-center gap-4 text-sm font-semibold text-caramel"
                    >
                        {page.page > 1 ? (
                            <a
                                href={directoryPath(letter, page.page - 1)}
                                rel="prev"
                                className="underline-offset-2 hover:underline"
                            >
                                ← Previous page
                            </a>
                        ) : null}
                        {page.page < page.pageCount ? (
                            <a
                                href={directoryPath(letter, page.page + 1)}
                                rel="next"
                                className="underline-offset-2 hover:underline"
                            >
                                Next page →
                            </a>
                        ) : null}
                    </nav>
                ) : null}
            </section>
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
