import { BASE_URL } from '@/lib/env.client'
import {
    DELETE_ACCOUNT_EMAIL,
    DELETE_ACCOUNT_PAGE_COPY,
    DELETE_ACCOUNT_PATH,
    DELETE_ACCOUNT_SECTIONS,
} from '@/lib/marketing/deleteAccountContent'
import type { Metadata } from 'next'
import Link from 'next/link'

// /delete-account — where a person who has no app open can learn how to delete
// their Caramel account. Google Play requires a web page for this (T-7505);
// before it, /delete-account was a 404. Static and prerendered: every sentence
// comes from src/lib/marketing/deleteAccountContent.ts, which the Markdown twin
// renders too. Linked from /privacy.

const canonicalUrl = `https://grabcaramel.com${DELETE_ACCOUNT_PATH}`
const banner = `${BASE_URL.replace(/\/+$/, '')}/caramel_banner.png`

export const metadata: Metadata = {
    title: DELETE_ACCOUNT_PAGE_COPY.title,
    description: DELETE_ACCOUNT_PAGE_COPY.description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title: DELETE_ACCOUNT_PAGE_COPY.title,
        description: DELETE_ACCOUNT_PAGE_COPY.description,
        siteName: 'Caramel',
        locale: 'en_US',
        images: [{ url: banner, width: 1200, height: 630 }],
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title: DELETE_ACCOUNT_PAGE_COPY.title,
        description: DELETE_ACCOUNT_PAGE_COPY.description,
        images: [banner],
    },
}

const linkClassName = 'font-semibold text-caramel underline hover:no-underline'

// Mixes custom colours (darkBg) with standard classes, which sort differently under the repo-root prettier (husky) and apps/caramel-app (CI). A constant is not sorted, so both agree.
const PAGE_CLASS =
    'dark:bg-darkBg flex min-h-screen w-full flex-col items-center px-6 pb-20 pt-32'

export default function DeleteAccountPage(): React.JSX.Element {
    return (
        <main className={PAGE_CLASS}>
            <div className="flex w-full max-w-4xl flex-col gap-8">
                <header className="flex flex-col gap-4">
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                        {DELETE_ACCOUNT_PAGE_COPY.heading}
                    </h1>
                    <p className="max-w-3xl text-gray-600 dark:text-gray-300">
                        {DELETE_ACCOUNT_PAGE_COPY.summary}
                    </p>
                </header>

                {DELETE_ACCOUNT_SECTIONS.map(section => (
                    <section
                        key={section.id}
                        id={section.id}
                        aria-labelledby={`${section.id}-heading`}
                        className="scroll-mt-28 border-t border-gray-200 pt-6 dark:border-white/10"
                    >
                        <h2
                            id={`${section.id}-heading`}
                            className="mb-3 text-xl font-semibold text-gray-900 dark:text-white"
                        >
                            {section.heading}
                        </h2>
                        <div className="flex flex-col gap-3 text-gray-600 dark:text-gray-300">
                            {section.paragraphs.map(paragraph => (
                                <p key={paragraph}>{paragraph}</p>
                            ))}
                            {section.steps ? (
                                <ol className="list-decimal space-y-1 pl-5">
                                    {section.steps.map(step => (
                                        <li key={step}>{step}</li>
                                    ))}
                                </ol>
                            ) : null}
                            {section.bullets ? (
                                <ul className="list-disc space-y-1 pl-5">
                                    {section.bullets.map(bullet => (
                                        <li key={bullet}>{bullet}</li>
                                    ))}
                                </ul>
                            ) : null}
                            {section.emailLink ? (
                                <p>
                                    <a
                                        href={`mailto:${DELETE_ACCOUNT_EMAIL}`}
                                        className={linkClassName}
                                    >
                                        {DELETE_ACCOUNT_PAGE_COPY.emailLabel}
                                    </a>
                                </p>
                            ) : null}
                        </div>
                    </section>
                ))}

                <p className="border-t border-gray-200 pt-6 text-gray-600 dark:border-white/10 dark:text-gray-300">
                    {DELETE_ACCOUNT_PAGE_COPY.privacyLead}{' '}
                    <Link href="/privacy" className={linkClassName}>
                        {DELETE_ACCOUNT_PAGE_COPY.privacyLabel}
                    </Link>
                    .
                </p>
            </div>
        </main>
    )
}
