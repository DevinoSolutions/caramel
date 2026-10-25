import { BASE_URL } from '@/lib/env.client'
import {
    DOCS_PAGE_COPY,
    DOCS_PATH,
    DOCS_SECTIONS,
    isExternalDocsLink,
    type DocsLink,
} from '@/lib/marketing/docsContent'
import type { Metadata } from 'next'
import Link from 'next/link'

// /docs — the documentation hub (T-7855). A fleet SEO/AEO probe found
// https://grabcaramel.com/docs returning 404 while every other Devino product
// serves a docs hub that agents and crawlers expect. Caramel has no separate
// docs site: this page IS the docs, and docs.grabcaramel.com 301s here from
// src/middleware.ts. e2e/docs-hub.spec.ts fails CI if either stops answering
// 200. Static and prerendered: every sentence comes from
// src/lib/marketing/docsContent.ts, which the Markdown twin renders too.

const canonicalUrl = `https://grabcaramel.com${DOCS_PATH}`
const banner = `${BASE_URL.replace(/\/+$/, '')}/caramel_banner.png`

export const metadata: Metadata = {
    title: DOCS_PAGE_COPY.title,
    description: DOCS_PAGE_COPY.description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title: DOCS_PAGE_COPY.title,
        description: DOCS_PAGE_COPY.description,
        siteName: 'Caramel',
        locale: 'en_US',
        images: [{ url: banner, width: 1200, height: 630 }],
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title: DOCS_PAGE_COPY.title,
        description: DOCS_PAGE_COPY.description,
        images: [banner],
    },
}

const linkClassName = 'font-semibold text-caramel underline hover:no-underline'

function DocsAnchor({ link }: { link: DocsLink }): React.JSX.Element {
    if (isExternalDocsLink(link.href)) {
        return (
            <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
            >
                {link.label}
            </a>
        )
    }
    if (link.resource) {
        return (
            <a href={link.href} className={linkClassName}>
                {link.label}
            </a>
        )
    }
    return (
        <Link href={link.href} className={linkClassName}>
            {link.label}
        </Link>
    )
}

export default function DocsPage(): React.JSX.Element {
    return (
        <main className="dark:bg-darkBg flex min-h-screen w-full flex-col items-center px-6 pb-20 pt-32">
            <div className="flex w-full max-w-4xl flex-col gap-8">
                <header className="flex flex-col gap-4">
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                        {DOCS_PAGE_COPY.heading}
                    </h1>
                    <p className="max-w-3xl text-gray-600 dark:text-gray-300">
                        {DOCS_PAGE_COPY.summary}
                    </p>
                </header>

                <nav
                    aria-label={DOCS_PAGE_COPY.contentsLabel}
                    className="dark:bg-darkSurface rounded-2xl border border-gray-200 bg-white p-5 dark:border-white/10"
                >
                    <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
                        {DOCS_PAGE_COPY.contentsLabel}
                    </p>
                    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                        {DOCS_SECTIONS.map(section => (
                            <li key={section.id}>
                                <a
                                    href={`#${section.id}`}
                                    className="text-caramel underline hover:no-underline"
                                >
                                    {section.heading}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>

                {DOCS_SECTIONS.map(section => (
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
                            <ul className="list-disc space-y-1 pl-5 text-sm">
                                {section.links.map(link => (
                                    <li key={link.href}>
                                        <DocsAnchor link={link} />
                                        {link.description
                                            ? `: ${link.description}`
                                            : null}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </section>
                ))}
            </div>
        </main>
    )
}
