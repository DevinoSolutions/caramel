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
// - Safari answer: the App Store listing (SAFARI_APP_STORE_URL) fetched
//   2026-09-12 states iPhone "Requires iOS 16.4 or later", iPad, Mac
//   "Requires macOS 13.0 or later" (versions deliberately not quoted here).
// - SimplyCodes answer: simplycodes.com fetched 2026-09-12 (200) links no
//   source code / GitHub anywhere — the same absence test claim-inventory
//   applies to Honey, Capital One Shopping, Rakuten and Coupert. Nothing
//   else about SimplyCodes is asserted.
// - Same-as-Honey answer: exists because ~400 impressions/90 days land on
//   the home page from people searching for Honey itself (`honey coupons`
//   187 impr, `honey coupon finder` 48, `honey code finder` 38 — positions
//   9–11); it answers them truthfully instead of pretending to be Honey.
// - numbers: 107,827 visible codes (GET /api/coupons?limit=1 → total) /
//   4,314 stores with live codes (sitemap /coupons/<store> URLs) from PROD on
//   2026-09-11, rounded DOWN. Never round up, and never derive the catalog
//   size from /api/coupons/stats (a valid-only trust census that undercounts).
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
        answer: "The extension never sells or shares your personal information, and it contains no ads and no third-party trackers. To do its job it talks to Caramel's own servers: as you browse, it asks whether Caramel has codes for the current site's domain so the toolbar badge can show a count; when you reach checkout on a supported store it fetches those codes, sends the page and cart context (page title and item names — never payment details) so the right category of codes is chosen, and reports whether a code worked (linked to your account only if you're signed in) so rankings stay accurate for everyone. Your settings and optional sign-in are kept in your browser's extension storage.",
    },
    {
        question: 'Is Caramel the same as Honey?',
        answer: "No. Caramel is an independent coupon extension, not affiliated with Honey or PayPal. Like Honey, it looks up coupon codes for the store you are checking out on and applies the best one; unlike Honey, its extension and web app are open source, it contains no affiliate code, and it leaves creators' affiliate links untouched.",
    },
    {
        question: 'How is Caramel different from Honey?',
        answer: "Honey has been publicly documented replacing creators' affiliate links with its own, and its code is closed source, so its behavior can't be independently audited. Caramel is the opposite by design: fully open source under the AGPL-3.0 license, it never touches affiliate links, and it is free with no premium tier.",
    },
    {
        question: 'How is Caramel different from SimplyCodes?',
        answer: "SimplyCodes does not publish its source code, so what its extension does with your data and with affiliate links can only be taken on trust. Caramel's extension and web app are published under the AGPL-3.0 license for anyone to audit, it contains no affiliate code at all, and it works without an account.",
    },
    {
        question: 'Which browsers does Caramel support?',
        answer: 'Caramel is available for Chrome on the Chrome Web Store, for Firefox on Firefox Add-ons, for Microsoft Edge on Edge Add-ons, and for Safari through the App Store.',
    },
    {
        question: 'Is there a Caramel coupon extension for Safari?',
        answer: 'Yes. Caramel ships as a Safari extension through the App Store for Mac (macOS) and for iPhone and iPad (iOS), and it is free there like every other version — the same open-source coupon extension as the Chrome, Firefox and Edge builds.',
    },
    {
        question: 'How many coupon codes does Caramel have?',
        answer: "Caramel's catalog holds over 100,000 coupon codes across more than 4,000 online stores, and it is refreshed continuously as new codes are found and dead ones are retired.",
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
