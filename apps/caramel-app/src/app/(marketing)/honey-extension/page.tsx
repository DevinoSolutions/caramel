import InstallCallout from '@/components/growth/InstallCallout'
import SourceRefList, { SourceList } from '@/components/seo/SourceRefs'
import { BASE_URL } from '@/lib/env.client'
import { faqPageJsonLd, jsonLdString } from '@/lib/jsonLd'
import {
    COMPARISON_CHECKED_ON,
    COMPARISON_PATH,
    HONEY_TIMELINE,
    formatComparisonDate,
    type ComparisonSourceId,
} from '@/lib/seo/extensionComparison'
import {
    CARAMEL_ROW,
    HONEY_GUIDE_FAQ,
    HONEY_GUIDE_PATH,
    HONEY_GUIDE_SUMMARY,
    HONEY_GUIDE_SUMMARY_SOURCES,
    HONEY_ROW,
    HONEY_VS_CARAMEL,
    honeyGuideSourceOrder,
} from '@/lib/seo/honeyExtensionGuide'
import type { Metadata } from 'next'
import Link from 'next/link'

// The Honey extension, explained (why it exists, and why it states nothing
// about Honey that /compare/coupon-extensions does not: honeyExtensionGuide.ts).
// A server component with no catalog read, so it prerenders: every answer and
// source is in the HTML an answer engine fetches, and the FAQPage JSON-LD is
// built from the same HONEY_GUIDE_FAQ array as the visible questions.

const origin = BASE_URL.replace(/\/+$/, '')
const canonical = `${origin}${HONEY_GUIDE_PATH}`
const checkedOn = formatComparisonDate(COMPARISON_CHECKED_ON)
const year = COMPARISON_CHECKED_ON.getUTCFullYear()

const title = `Honey Extension in ${year}: What Changed and the Controversy Explained | Caramel`
const description = `What PayPal's Honey extension does, how it makes money, the affiliate-link controversy and lawsuit, and how Caramel differs. Every claim sourced.`
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

const sourceOrder = honeyGuideSourceOrder()

function PageSourceRefs({ ids }: { ids: ReadonlyArray<ComparisonSourceId> }) {
    return <SourceRefList ids={ids} order={sourceOrder} />
}

const sectionHeading =
    'mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white'
const bodyText = 'leading-relaxed text-gray-700 dark:text-gray-300'
const inlineLink = 'font-semibold text-caramel hover:underline'

export default function HoneyExtensionPage() {
    const breadcrumbData = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: origin },
            {
                '@type': 'ListItem',
                position: 2,
                name: 'The Honey extension, explained',
            },
        ],
    }

    return (
        <main className="relative min-h-screen px-6 pb-24 pt-32 dark:bg-darkBg lg:px-8">
            <article className="mx-auto max-w-4xl">
                <header className="pb-10">
                    <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-gray-900 dark:text-white md:text-3xl">
                        The Honey extension in {year}: what it does and what
                        changed
                    </h1>
                    <p className={`${bodyText} text-lg`}>
                        {HONEY_GUIDE_SUMMARY}
                        <PageSourceRefs ids={HONEY_GUIDE_SUMMARY_SOURCES} />
                    </p>
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                        Checked on{' '}
                        <time dateTime={COMPARISON_CHECKED_ON.toISOString()}>
                            {checkedOn}
                        </time>
                        . Every statement about Honey comes from PayPal&apos;s
                        own help center, its browser store listings, the browser
                        stores&apos; own policies, court orders or named news
                        outlets, numbered in the sources below. Caramel is our
                        extension, so check those sources rather than taking our
                        word for it.
                    </p>
                </header>

                <section
                    aria-labelledby="honey-vs-caramel-heading"
                    className="pb-12"
                >
                    <h2
                        id="honey-vs-caramel-heading"
                        className={sectionHeading}
                    >
                        Honey and Caramel side by side
                    </h2>
                    <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
                        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
                            <caption className="sr-only">
                                Honey and Caramel compared on maker, price,
                                revenue, rewards, account, browsers and source
                                code, as checked on {checkedOn}
                            </caption>
                            <thead className="bg-gray-50 text-gray-900 dark:bg-darkSurface dark:text-white">
                                <tr>
                                    <th scope="col" className="px-4 py-3">
                                        <span className="sr-only">
                                            Compared on
                                        </span>
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        Honey
                                        <PageSourceRefs
                                            ids={HONEY_ROW.sources}
                                        />
                                    </th>
                                    <th scope="col" className="px-4 py-3">
                                        Caramel
                                        <PageSourceRefs
                                            ids={CARAMEL_ROW.sources}
                                        />
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 text-gray-700 dark:divide-white/10 dark:text-gray-300">
                                {HONEY_VS_CARAMEL.map(row => (
                                    <tr key={row.label} className="align-top">
                                        <th
                                            scope="row"
                                            className="px-4 py-3 font-semibold text-gray-900 dark:text-white"
                                        >
                                            {row.label}
                                        </th>
                                        <td className="px-4 py-3">
                                            {row.honey}
                                        </td>
                                        <td className="px-4 py-3">
                                            {row.caramel}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <InstallCallout
                        placement="honey_extension"
                        lead="Want one with no affiliate code?"
                        body="Caramel finds and applies coupon codes at checkout. Free, no account, open source."
                    />
                </section>

                <section
                    aria-labelledby="honey-timeline-heading"
                    className="pb-12"
                >
                    <h2 id="honey-timeline-heading" className={sectionHeading}>
                        What happened with Honey
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
                </section>

                <section aria-labelledby="honey-faq-heading" className="pb-12">
                    <h2 id="honey-faq-heading" className={sectionHeading}>
                        Questions about the Honey extension
                    </h2>
                    <div className="space-y-6">
                        {HONEY_GUIDE_FAQ.map(item => (
                            <div key={item.question}>
                                <h3 className="mb-1 text-lg font-semibold text-gray-900 dark:text-white">
                                    {item.question}
                                </h3>
                                <p className={bodyText}>{item.answer}</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Sources
                                    <PageSourceRefs ids={item.sources} />
                                </p>
                            </div>
                        ))}
                    </div>
                    <p className={`${bodyText} mt-6`}>
                        Looking past Honey? See how{' '}
                        <Link href="/" className={inlineLink}>
                            Caramel, the open-source Honey alternative
                        </Link>
                        , works, or read{' '}
                        <Link href={COMPARISON_PATH} className={inlineLink}>
                            the best coupon extensions compared
                        </Link>{' '}
                        (Honey, Capital One Shopping, SimplyCodes, Rakuten and
                        Coupert).
                    </p>
                </section>

                <section aria-labelledby="honey-sources-heading">
                    <h2 id="honey-sources-heading" className={sectionHeading}>
                        Sources
                    </h2>
                    <SourceList order={sourceOrder} />
                </section>
            </article>
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(faqPageJsonLd(HONEY_GUIDE_FAQ)),
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
