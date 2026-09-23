import { faqItems } from '@/lib/faqItems'
import { FaChevronDown } from 'react-icons/fa'

// Deliberately a SERVER component (no 'use client'): AI answer engines and
// crawlers extract VISIBLE HTML at retrieval time, so every answer below must
// be present in the server-rendered DOM with zero client JS. The accordion is
// native <details>/<summary> — accessible, keyboard-operable, and the collapsed
// answers are still in the DOM. The FAQPage JSON-LD script is generated from
// the SAME array as the visible markup, so the two can never drift. The
// array itself (and its claim-integrity ledger) lives in src/lib/faqItems.ts
// so /llms-full.txt can render the same strings.

const faqStructuredData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map(item => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
            '@type': 'Answer',
            text: item.answer,
        },
    })),
}

export default function FaqSection(): React.JSX.Element {
    return (
        <section id="faq" className="relative overflow-hidden py-32">
            {/* Background hairlines — same section framing as the siblings. */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
            </div>

            <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
                <div className="mb-16 text-center">
                    <h2 className="mb-8 text-5xl font-extrabold leading-tight tracking-tight text-caramel lg:text-4xl">
                        Frequently Asked Questions
                    </h2>
                    <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg">
                        Straight answers about affiliate links, pricing, data,
                        and where Caramel runs
                    </p>
                </div>

                <div className="mx-auto max-w-4xl space-y-4">
                    {faqItems.map(item => (
                        /* Opaque base color (bg-gray-50/darkBg = the page bg the
                           translucent gradient already composited over, so the
                           card looks identical) — without it the fixed Doodles
                           ornament layer (z-[1]) showed THROUGH the low-alpha
                           card gradient and painted "over" the card surface.
                           z-order was never the issue: this z-10 container
                           already beats z-[1]; only opacity stops show-through. */
                        <details
                            key={item.question}
                            className="group overflow-hidden rounded-2xl border border-caramel/20 bg-gray-50 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 shadow-md transition-all duration-300 open:border-caramel/60 hover:border-caramel/60 dark:border-caramel/30 dark:bg-darkBg dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10"
                        >
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-6 text-left text-lg font-bold tracking-tight text-gray-800 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/70 dark:text-white sm:p-4 sm:text-base [&::-webkit-details-marker]:hidden">
                                {item.question}
                                <FaChevronDown
                                    aria-hidden="true"
                                    className="flex-shrink-0 text-caramel transition-transform duration-300 group-open:rotate-180"
                                />
                            </summary>
                            <p className="px-6 pb-6 text-base leading-relaxed text-gray-600 dark:text-gray-400 sm:px-4 sm:pb-4 sm:text-sm">
                                {item.answer}
                            </p>
                        </details>
                    ))}
                </div>
            </div>

            {/* FAQPage rich-result markup — built from the SAME faqItems array
                as the visible accordion above, so the JSON-LD text always
                mirrors the DOM exactly. NO rating/review markup, ever. */}
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    __html: JSON.stringify(faqStructuredData),
                }}
            />
        </section>
    )
}
