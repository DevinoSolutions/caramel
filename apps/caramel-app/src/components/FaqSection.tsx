import { FaChevronDown } from 'react-icons/fa'

// Deliberately a SERVER component (no 'use client'): AI answer engines and
// crawlers extract VISIBLE HTML at retrieval time, so every answer below must
// be present in the server-rendered DOM with zero client JS. The accordion is
// native <details>/<summary> — accessible, keyboard-operable, and the collapsed
// answers are still in the DOM. The FAQPage JSON-LD script is generated from
// the SAME array as the visible markup, so the two can never drift.
//
// CLAIM INTEGRITY (verified 2026-07-28 — engines quote this copy verbatim):
// - affiliate answer: zero affiliate/referral/utm logic in apps/caramel-extension.
// - free answer: PricingSection ("Free Forever Plan", no paid tier).
// - data answer: extension network surface = background.js (fetchCoupons by
//   store domain, classifyCart page/cart signals, reportOutcome worked/failed)
//   + cart-signals.js payload (title/meta/up to 6 item names, no payment data);
//   sign-in token lives in browser extension storage (popup.js/coupon-runner.js).
// - browsers: the four live store listings in src/lib/brandLinks.ts.
// - numbers: 139,340 active codes / 3,402 distinct stores from the PROD
//   /api/coupons/stats + catalog on 2026-07-28, rounded DOWN. Never round up.
const faqItems = [
    {
        question: 'Does Caramel replace or hijack creator affiliate links?',
        answer: 'No. The Caramel coupon extension never replaces, overrides, or injects affiliate links — there is no affiliate code anywhere in the extension, and because it is open source you can verify that yourself. Creators keep 100% of their commissions when you shop with Caramel installed.',
    },
    {
        question: 'Is Caramel really free?',
        answer: 'Yes. Caramel is free forever — there is no premium tier, no hidden fees, and no credit card required. The project is open source and maintained by Devino Solutions together with community contributors.',
    },
    {
        question: 'What data does the Caramel extension collect?',
        answer: "The extension never sells or shares your personal information, and it contains no ads and no third-party trackers. To do its job it talks to Caramel's own servers: when you reach checkout on a supported store it fetches coupon codes for that store's domain, sends the page and cart context (page title and item names — never payment details) so the right category of codes is chosen, and reports whether a code worked so rankings stay accurate for everyone. Your settings and optional sign-in are kept in your browser's extension storage.",
    },
    {
        question: 'How is Caramel different from Honey?',
        answer: "Honey has been publicly documented replacing creators' affiliate links with its own, and its code is closed source, so its behavior can't be independently audited. Caramel is the opposite by design: fully open source under the AGPL-3.0 license, it never touches affiliate links, and it is free with no premium tier.",
    },
    {
        question: 'Which browsers does Caramel support?',
        answer: 'Caramel is available for Chrome on the Chrome Web Store, for Firefox on Firefox Add-ons, for Microsoft Edge on Edge Add-ons, and for Safari through the App Store.',
    },
    {
        question: 'How many coupon codes does Caramel have?',
        answer: "Caramel's catalog holds over 139,000 active coupon codes across more than 3,000 online stores, and it is refreshed continuously as new codes are found and dead ones are retired.",
    },
    {
        question: 'Do I need an account to use Caramel?',
        answer: 'No. You can install Caramel and let it apply coupons at checkout without creating an account. Signing in is optional.',
    },
]

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
