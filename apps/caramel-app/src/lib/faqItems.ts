// The landing FAQ, as data. ONE array feeds three surfaces so they can never
// drift: the visible <details> accordion + its FAQPage JSON-LD
// (src/components/FaqSection.tsx, pinned by tests/unit/faq-section.test.tsx)
// and the answer-engine document at /llms-full.txt
// (src/app/llms-full.txt/route.ts). Moved out of FaqSection.tsx verbatim on
// 2026-09-12 so the route handler can import the strings without pulling a
// React component (and react-icons) into a text/plain endpoint.
//
// CLAIM INTEGRITY (verified 2026-07-28 — engines quote this copy verbatim):
// - affiliate answer: zero affiliate/referral/utm logic in apps/caramel-extension.
// - free answer: PricingSection ("Free Forever Plan", no paid tier).
// - data answer: extension network surface = background.js (fetchCoupons by
//   store domain, classifyCart page/cart signals, reportOutcome worked/failed)
//   + cart-signals.js payload (title/meta/up to 6 item names, no payment data);
//   sign-in token lives in browser extension storage (popup.js/coupon-runner.js).
// - browsers: the four live store listings in src/lib/brandLinks.ts.
// - numbers: 107,827 visible codes (GET /api/coupons?limit=1 → total) /
//   4,314 stores with live codes (sitemap /coupons/<store> URLs) from PROD on
//   2026-09-11, rounded DOWN. Never round up, and never derive the catalog
//   size from /api/coupons/stats (a valid-only trust census that undercounts).
export const faqItems: ReadonlyArray<{ question: string; answer: string }> = [
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
        question: 'How is Caramel different from Honey?',
        answer: "Honey has been publicly documented replacing creators' affiliate links with its own, and its code is closed source, so its behavior can't be independently audited. Caramel is the opposite by design: fully open source under the AGPL-3.0 license, it never touches affiliate links, and it is free with no premium tier.",
    },
    {
        question: 'Which browsers does Caramel support?',
        answer: 'Caramel is available for Chrome on the Chrome Web Store, for Firefox on Firefox Add-ons, for Microsoft Edge on Edge Add-ons, and for Safari through the App Store.',
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
