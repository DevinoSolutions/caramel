import { BASE_URL } from '@/lib/env.client'
import {
    AFFILIATE_POLICY_CHECKED_ON,
    AFFILIATE_POLICY_COPY,
    AFFILIATE_POLICY_PATH,
    AFFILIATE_POLICY_SECTIONS,
    AFFILIATE_POLICY_TEST_URL,
} from '@/lib/marketing/affiliatePolicyContent'
import { formatComparisonDate } from '@/lib/seo/extensionComparison'
import type { Metadata } from 'next'
import Link from 'next/link'

// What the extension does and does not do with affiliate links, tracking codes
// and cookies. A server component with no data read, so it prerenders. The
// copy lives in affiliatePolicyContent.ts and is pinned by
// tests/unit/affiliate-policy.test.ts; the extension side by
// apps/caramel-extension/tests/affiliate-integrity.test.mjs.

const origin = BASE_URL.replace(/\/+$/, '')
const canonical = `${origin}${AFFILIATE_POLICY_PATH}`
const banner = `${origin}/caramel_banner.png`
const { title, description } = AFFILIATE_POLICY_COPY

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

const sectionHeading =
    'mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white'
const bodyText = 'leading-relaxed text-gray-700 dark:text-gray-300'
const inlineLink = 'font-semibold text-caramel hover:underline'

export default function AffiliatePolicyPage() {
    const copy = AFFILIATE_POLICY_COPY
    return (
        <main className="relative min-h-screen px-6 pb-24 pt-32 dark:bg-darkBg lg:px-8">
            <article className="mx-auto max-w-4xl">
                <header className="pb-10">
                    <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-gray-900 dark:text-white md:text-3xl">
                        {copy.heading}
                    </h1>
                    <p className={`${bodyText} text-lg`}>{copy.summary}</p>
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                        {copy.checkedOn}{' '}
                        <time
                            dateTime={AFFILIATE_POLICY_CHECKED_ON.toISOString()}
                        >
                            {formatComparisonDate(AFFILIATE_POLICY_CHECKED_ON)}
                        </time>
                        {copy.checkedOnAfter}
                    </p>
                </header>

                {AFFILIATE_POLICY_SECTIONS.map(section => (
                    <section
                        key={section.id}
                        aria-labelledby={`${section.id}-heading`}
                        className="pb-12"
                    >
                        <h2
                            id={`${section.id}-heading`}
                            className={sectionHeading}
                        >
                            {section.heading}
                        </h2>
                        {section.intro ? (
                            <p className={`${bodyText} mb-4`}>
                                {section.intro}
                            </p>
                        ) : null}
                        <ul className="list-disc space-y-3 pl-6">
                            {section.items.map(item => (
                                <li key={item} className={bodyText}>
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}

                <section aria-labelledby="check-heading" className="pb-12">
                    <h2 id="check-heading" className={sectionHeading}>
                        {copy.checkHeading}
                    </h2>
                    <p className={bodyText}>
                        {copy.checkBefore}
                        <a
                            href={AFFILIATE_POLICY_TEST_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={inlineLink}
                        >
                            {copy.checkLink}
                        </a>
                        {copy.checkAfter}
                    </p>
                    <p className={`${bodyText} mt-4`}>
                        {copy.reportBefore}
                        <Link href="/support" className={inlineLink}>
                            {copy.reportLink}
                        </Link>
                        {copy.reportAfter}
                    </p>
                </section>
            </article>
        </main>
    )
}
