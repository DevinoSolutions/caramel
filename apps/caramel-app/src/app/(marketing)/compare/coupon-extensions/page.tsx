import InstallCallout from '@/components/growth/InstallCallout'
import SourceRefList, { SourceList } from '@/components/seo/SourceRefs'
import { BASE_URL } from '@/lib/env.client'
import { faqPageJsonLd, jsonLdString } from '@/lib/jsonLd'
import {
    COMPARED_EXTENSIONS,
    COMPARISON_CHECKED_ON,
    COMPARISON_FAQ,
    COMPARISON_PATH,
    COMPARISON_PICKS,
    COMPARISON_SUMMARY,
    HONEY_TIMELINE,
    comparisonSourceOrder,
    formatComparisonDate,
    type ComparisonSourceId,
} from '@/lib/seo/extensionComparison'
import { COMPARISON_BODY, GUIDE_BODY } from '@/lib/seo/guidePageCopy'
import { HONEY_GUIDE_PATH } from '@/lib/seo/honeyExtensionGuide'
import type { Metadata } from 'next'
import Link from 'next/link'

// The coupon-extension comparison (why it exists, and its claim-integrity
// rules: src/lib/seo/extensionComparison.ts). A server component with no
// catalog read, so it prerenders: every table cell, answer and source is in
// the HTML an answer engine fetches. The FAQPage JSON-LD is built from the
// same COMPARISON_FAQ array as the visible questions.

const origin = BASE_URL.replace(/\/+$/, '')
const canonical = `${origin}${COMPARISON_PATH}`
const checkedOn = formatComparisonDate(COMPARISON_CHECKED_ON)
const year = COMPARISON_CHECKED_ON.getUTCFullYear()

const title = `Best Coupon Extensions ${year}: Honey vs SimplyCodes | Caramel`
const description = `Honey, Capital One Shopping, SimplyCodes, Rakuten, Coupert and Caramel compared on price, business model, rewards and browsers. Checked ${checkedOn}.`
const banner = `${origin}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
        type: 'article',
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

const sourceOrder = comparisonSourceOrder()

function PageSourceRefs({ ids }: { ids: ReadonlyArray<ComparisonSourceId> }) {
    return <SourceRefList ids={ids} order={sourceOrder} />
}

const sectionHeading =
    'mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white'
const bodyText = 'leading-relaxed text-gray-700 dark:text-gray-300'

export default function CompareCouponExtensionsPage() {
    const breadcrumbData = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: origin },
            {
                '@type': 'ListItem',
                position: 2,
                name: 'Coupon extensions compared',
            },
        ],
    }

    return (
        <main className="relative min-h-screen px-6 pb-24 pt-32 dark:bg-darkBg lg:px-8">
            <article className="mx-auto max-w-5xl">
                <header className="pb-10">
                    <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-gray-900 dark:text-white md:text-3xl">
                        {COMPARISON_BODY.heading}
                    </h1>
                    <p className={`${bodyText} text-lg`}>
                        {COMPARISON_SUMMARY}
                    </p>
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                        {GUIDE_BODY.checkedOn}{' '}
                        <time dateTime={COMPARISON_CHECKED_ON.toISOString()}>
                            {checkedOn}
                        </time>
                        {COMPARISON_BODY.sourceNote}
                    </p>
                </header>

                <section
                    aria-labelledby="compare-table-heading"
                    className="pb-12"
                >
                    <h2 id="compare-table-heading" className={sectionHeading}>
                        {COMPARISON_BODY.tableHeading}
                    </h2>
                    <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
                        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                            <caption className="sr-only">
                                Coupon extensions compared on price, revenue,
                                rewards, account, browsers, source code and
                                sources, as checked on {checkedOn}
                            </caption>
                            <thead className="bg-gray-50 text-gray-900 dark:bg-darkSurface dark:text-white">
                                <tr>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.name}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.price}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.revenue}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.rewards}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.account}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.browsers}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {COMPARISON_BODY.tableLabels.sourceCode}
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        {GUIDE_BODY.sourcesHeading}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 text-gray-700 dark:divide-white/10 dark:text-gray-300">
                                {COMPARED_EXTENSIONS.map(row => (
                                    <tr key={row.name} className="align-top">
                                        <th
                                            scope="row"
                                            className="px-4 py-3 font-semibold text-gray-900 dark:text-white"
                                        >
                                            {row.name}
                                            <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                                                {row.maker}
                                            </span>
                                        </th>
                                        <td className="px-4 py-3">
                                            {row.price}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.revenue}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.rewards}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.account}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.browsers}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.sourceCode}
                                        </td>
                                        <td className="px-4 py-3">
                                            <PageSourceRefs ids={row.sources} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section
                    aria-labelledby="compare-picks-heading"
                    className="pb-12"
                >
                    <h2 id="compare-picks-heading" className={sectionHeading}>
                        {COMPARISON_BODY.picksHeading}
                    </h2>
                    <dl className="space-y-4">
                        {COMPARISON_PICKS.map(pick => (
                            <div key={pick.need}>
                                <dt className="font-semibold text-gray-900 dark:text-white">
                                    {pick.need}
                                </dt>
                                <dd className={bodyText}>{pick.answer}</dd>
                            </div>
                        ))}
                    </dl>
                    <InstallCallout
                        placement="compare_extensions"
                        lead={COMPARISON_BODY.installLead}
                        body={GUIDE_BODY.installBody}
                    />
                </section>

                <section
                    aria-labelledby="compare-honey-heading"
                    className="pb-12"
                >
                    <h2 id="compare-honey-heading" className={sectionHeading}>
                        {GUIDE_BODY.timelineHeading}
                    </h2>
                    <ol className="space-y-4 border-l-2 border-caramel/30 pl-6">
                        {HONEY_TIMELINE.map(event => (
                            <li key={`${event.date}-${event.text}`}>
                                <time
                                    dateTime={event.date}
                                    className="block text-sm font-semibold text-caramel"
                                >
                                    {formatComparisonDate(
                                        new Date(`${event.date}T00:00:00Z`),
                                    )}
                                </time>
                                <p className={bodyText}>
                                    {event.text}
                                    <PageSourceRefs ids={event.sources} />
                                </p>
                            </li>
                        ))}
                    </ol>
                    <p className={`${bodyText} mt-6`}>
                        {COMPARISON_BODY.honeyBefore}
                        <Link
                            href={HONEY_GUIDE_PATH}
                            className="font-semibold text-caramel hover:underline"
                        >
                            {COMPARISON_BODY.honeyLink}
                        </Link>
                        .
                    </p>
                </section>

                <section
                    aria-labelledby="compare-faq-heading"
                    className="pb-12"
                >
                    <h2 id="compare-faq-heading" className={sectionHeading}>
                        {COMPARISON_BODY.faqHeading}
                    </h2>
                    <div className="space-y-6">
                        {COMPARISON_FAQ.map(item => (
                            <div key={item.question}>
                                <h3 className="mb-1 text-lg font-semibold text-gray-900 dark:text-white">
                                    {item.question}
                                </h3>
                                <p className={bodyText}>{item.answer}</p>
                            </div>
                        ))}
                    </div>
                    <p className={`${bodyText} mt-6`}>
                        {COMPARISON_BODY.onwardBefore}
                        <Link
                            href="/faq"
                            className="font-semibold text-caramel hover:underline"
                        >
                            {COMPARISON_BODY.faqLink}
                        </Link>
                        {COMPARISON_BODY.onwardBetween}
                        <Link
                            href="/coupons/stores"
                            className="font-semibold text-caramel hover:underline"
                        >
                            {COMPARISON_BODY.directoryLink}
                        </Link>
                        .
                    </p>
                </section>

                <section aria-labelledby="compare-sources-heading">
                    <h2 id="compare-sources-heading" className={sectionHeading}>
                        {GUIDE_BODY.sourcesHeading}
                    </h2>
                    <SourceList order={sourceOrder} />
                </section>
            </article>
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(faqPageJsonLd(COMPARISON_FAQ)),
                }}
            />
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
