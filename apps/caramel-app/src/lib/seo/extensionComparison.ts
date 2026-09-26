// The coupon-extension comparison, as data. ONE module feeds the page at
// /compare/coupon-extensions, its FAQPage JSON-LD and the comparison section
// of /llms-full.txt, so the three cannot drift.
//
// Why it exists: Search Console (2026-06-28 to 09-25) shows "simplycodes vs
// honey" (77 impressions, p9.7), "best coupon extension(s)" (~90, p7-14, zero
// clicks) and long "alternative to Capital One Shopping" questions landing on
// the home page, which answers none of them. The home page already ranks 1-2
// for "honey alternative", so this page deliberately does NOT use that phrase
// in its title or h1 (no cannibalisation).
//
// CLAIM INTEGRITY: this page makes public statements about competitors, and
// answer engines quote it verbatim. Every competitor statement below was read
// from the vendor's own site, its browser store listing, a court order or a
// named outlet on COMPARISON_CHECKED_ON, and each row/event cites its sources.
// Deliberately NOT claimed (tempting, unverified on 2026-09-26): that Rakuten's
// extension was pulled from Chrome (its install link showed "This item is not
// available" from Canada; could be regional), that Honey or Capital One
// Shopping REQUIRE an account to apply codes (neither says so), that Honey
// stopped earning commissions when no code applies, any Honey user-loss or
// merchant-count figure, other affiliate networks dropping Honey, and PayPal
// "saying merchants decide which coupons are offered" (that is USA TODAY's
// paraphrase, not a PayPal quote). Re-check everything before changing the
// date.
import { GITHUB_REPO_URL } from '@/lib/brandLinks'

/** The day every competitor fact below was last read from its source. */
export const COMPARISON_CHECKED_ON = new Date('2026-09-26T00:00:00Z')

export const COMPARISON_PATH = '/compare/coupon-extensions'

/** "September 26, 2026", in UTC so the server's timezone never shifts the
 *  day. Used by the page and /llms-full.txt alike. */
export function formatComparisonDate(date: Date): string {
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
    })
}

export type ComparisonSource = {
    title: string
    publisher: string
    url: string
}

export const COMPARISON_SOURCES = {
    honeyHelpWhat: {
        title: 'Get to know the Honey browser extension',
        publisher: 'PayPal Honey Help Center',
        url: 'https://help.joinhoney.com/article/39-what-is-the-honey-extension-and-how-do-i-get-it',
    },
    honeyHelpMoney: {
        title: 'How does Honey make money?',
        publisher: 'PayPal Honey Help Center',
        url: 'https://help.joinhoney.com/article/30-how-does-honey-make-money',
    },
    honeyChrome: {
        title: 'Honey: Automated Coupons & Rewards',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/bmnlcjabgnpnenekpadlanbbkooimhnj',
    },
    honeyFirefox: {
        title: 'Honey',
        publisher: 'Firefox Add-ons',
        url: 'https://addons.mozilla.org/en-US/firefox/addon/honey/',
    },
    capitalOneHelp: {
        title: 'Help Center',
        publisher: 'Capital One Shopping',
        url: 'https://capitaloneshopping.com/help',
    },
    capitalOneChrome: {
        title: 'Capital One Shopping',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/nenlahapcbofgnanklpelkaejcehkggg',
    },
    simplyCodesExtension: {
        title: 'SimplyCodes extension',
        publisher: 'SimplyCodes',
        url: 'https://simplycodes.com/extension',
    },
    simplyCodesHelp: {
        title: 'SimplyCodes help',
        publisher: 'SimplyCodes',
        url: 'https://simplycodes.com/help',
    },
    simplyCodesChrome: {
        title: 'SimplyCodes',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/gfkpklgmocbcbdabfellcnikamdaeajd',
    },
    rakutenHowItWorks: {
        title: 'How Does Rakuten Work?',
        publisher: 'Rakuten',
        url: 'https://www.rakuten.com/help/article/how-does-rakuten-work-360002117047',
    },
    rakutenExtension: {
        title: 'What Is the Rakuten Browser Extension and How Does It Work?',
        publisher: 'Rakuten',
        url: 'https://www.rakuten.com/blog/rakuten-browser-extension-explained/',
    },
    coupertFree: {
        title: 'Is Coupert free to use?',
        publisher: 'Coupert Help Center',
        url: 'https://help.coupert.com/platform-products/coupert-extension-faq/is-coupert-free-to-use/',
    },
    coupertChrome: {
        title: 'Coupert',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/mfidniedemcgceagapgdekdbmanojomk',
    },
    coupertPureChrome: {
        title: 'Coupert Pure',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/gdhpobnkinppekiaabcndnleaejeddod',
    },
    caramelSource: {
        title: 'Caramel source code (AGPL-3.0)',
        publisher: 'GitHub',
        url: GITHUB_REPO_URL,
    },
    usaToday: {
        title: "Honey controversy, explained: Why a YouTuber claims coupon-finder is 'exploiting' influencers",
        publisher: 'USA TODAY (via Yahoo News), December 27, 2024',
        url: 'https://ca.news.yahoo.com/honey-controversy-explained-why-youtuber-233401909.html',
    },
    fortune: {
        title: 'Is Honey a scam? Money-saving browser extension accused of ripping off customers, influencers',
        publisher: 'Fortune, December 23, 2024',
        url: 'https://fortune.com/2024/12/23/honey-extension-scam-drama/',
    },
    chromePolicyBlog: {
        title: 'Chrome Web Store policy updates: Strengthening our policies on affiliate programs in Chrome Extensions',
        publisher: 'Chrome for Developers, March 11, 2025',
        url: 'https://developer.chrome.com/blog/cws-policy-update-affiliate-ads-2025',
    },
    chromePolicy: {
        title: 'Affiliate Ads (Chrome Web Store program policies)',
        publisher: 'Chrome for Developers',
        url: 'https://developer.chrome.com/docs/webstore/program-policies/affiliate-ads',
    },
    honeyDisclosure: {
        title: 'Honey adds affiliate disclosure to its Chrome listing',
        publisher: '9to5Google, March 12, 2025',
        url: 'https://9to5google.com/2025/03/12/honey-affiliate-disclosure-google-chrome-listing/',
    },
    courtOrder2025: {
        title: 'Wendover Productions v. PayPal: order granting motion to dismiss first amended complaint (Doc. 237)',
        publisher:
            'U.S. District Court, N.D. Cal., case 5:24-cv-09470, November 21, 2025',
        url: 'https://storage.courtlistener.com/recap/gov.uscourts.cand.441974/gov.uscourts.cand.441974.237.0.pdf',
    },
    courtOrder2026: {
        title: 'Wendover Productions v. PayPal: order denying motion to dismiss second amended complaint (Doc. 277)',
        publisher:
            'U.S. District Court, N.D. Cal., case 5:24-cv-09470, June 22, 2026',
        url: 'https://storage.courtlistener.com/recap/gov.uscourts.cand.441974/gov.uscourts.cand.441974.277.0.pdf',
    },
} as const satisfies Record<string, ComparisonSource>

export type ComparisonSourceId = keyof typeof COMPARISON_SOURCES

export type ComparedExtension = {
    name: string
    maker: string
    price: string
    /** How it earns money, as the vendor itself states it. */
    revenue: string
    rewards: string
    /** Whether codes work without an account, as the vendor states it. */
    account: string
    browsers: string
    sourceCode: string
    sources: ReadonlyArray<ComparisonSourceId>
}

export const COMPARED_EXTENSIONS: ReadonlyArray<ComparedExtension> = [
    {
        name: 'Caramel',
        maker: 'Devino (open source)',
        price: 'Free, no paid tier',
        revenue:
            'No affiliate commissions: the extension contains no affiliate code',
        rewards: 'None',
        account: 'Not needed',
        browsers: 'Chrome, Firefox, Edge, Safari',
        sourceCode: 'Published (AGPL-3.0)',
        sources: ['caramelSource'],
    },
    {
        name: 'Honey',
        maker: 'PayPal',
        price: 'Free',
        revenue: 'Affiliate commissions from merchants',
        rewards: 'PayPal Rewards',
        account: 'Only mentioned for rewards',
        browsers:
            'Chrome, Edge, Safari, Opera; Firefox listing last updated February 2021',
        sourceCode: 'Not published',
        sources: [
            'honeyHelpWhat',
            'honeyHelpMoney',
            'honeyChrome',
            'honeyFirefox',
        ],
    },
    {
        name: 'Capital One Shopping',
        maker: 'Capital One',
        price: 'Free; no Capital One bank account needed',
        revenue: 'Affiliate commissions from merchants, shared as rewards',
        rewards: 'Capital One Shopping Rewards',
        account: 'Not stated for codes',
        browsers: 'Chrome, Firefox, Edge, Safari',
        sourceCode: 'Not published',
        sources: ['capitalOneHelp', 'capitalOneChrome'],
    },
    {
        name: 'SimplyCodes',
        maker: 'Demand.io',
        price: 'Free',
        revenue: 'Merchant commissions on sales made with its codes',
        rewards: 'Tokens (100 tokens = $1)',
        account: 'Not needed to find and use codes',
        browsers: 'Chrome, Firefox, Safari, Edge',
        sourceCode: 'Not published',
        sources: [
            'simplyCodesExtension',
            'simplyCodesHelp',
            'simplyCodesChrome',
        ],
    },
    {
        name: 'Rakuten',
        maker: 'Rakuten',
        price: 'Free',
        revenue: 'Store commissions, part shared as Cash Back',
        rewards: 'Rakuten Cash Back',
        account: 'Only mentioned for Cash Back',
        browsers: 'Chrome, Edge, Firefox, Safari (as Rakuten lists them)',
        sourceCode: 'Not published',
        sources: ['rakutenHowItWorks', 'rakutenExtension'],
    },
    {
        name: 'Coupert',
        maker: 'Coupert',
        price: 'Free; a separate paid version, Coupert Pure, is also offered',
        revenue: 'Affiliate commissions from stores, shared as Cash Back',
        rewards: 'Cash Back',
        account: 'Only mentioned for Cash Back',
        browsers: 'Chrome, Safari, Firefox, Edge',
        sourceCode: 'Not published',
        sources: ['coupertFree', 'coupertChrome', 'coupertPureChrome'],
    },
]

/** The opening answer: what an answer engine should be able to quote alone. */
export const COMPARISON_SUMMARY =
    'Every coupon extension compared here is free to install. What differs is how each makes money, what it asks of you, and whether you can check what it does. Honey, Capital One Shopping, SimplyCodes, Rakuten and Coupert each state that stores pay them commissions on your purchases, and most share part of that back as rewards. Caramel contains no affiliate code, has no rewards program, and is the only one here that publishes its source code.'

export type ComparisonPick = { need: string; answer: string }

/** "Which one should you use?": each answer follows from the table rows. */
export const COMPARISON_PICKS: ReadonlyArray<ComparisonPick> = [
    {
        need: 'You want cash back',
        answer: 'Rakuten, Capital One Shopping, Coupert and Honey share the commissions stores pay them with you as rewards. Caramel has no rewards program.',
    },
    {
        need: "You don't want an account",
        answer: 'SimplyCodes says its codes work without one, and Caramel needs none.',
    },
    {
        need: 'You want to check what the extension does',
        answer: 'Caramel is the only one here that publishes its source code (AGPL-3.0), so what it does can be read rather than taken on trust.',
    },
    {
        need: "You buy through creators' links",
        answer: "Caramel contains no affiliate code, so a creator's referral link stays untouched. The others earn commissions from stores on your purchases; the timeline below covers the dispute over Honey and creators' links.",
    },
]

export type ComparisonEvent = {
    /** ISO date (YYYY-MM-DD) the event happened. */
    date: string
    text: string
    sources: ReadonlyArray<ComparisonSourceId>
}

/** What happened with Honey, in order, each step sourced. */
export const HONEY_TIMELINE: ReadonlyArray<ComparisonEvent> = [
    {
        date: '2024-12-21',
        text: 'YouTuber MegaLag publishes "Exposing the Honey Influencer Scam", alleging that Honey replaced creators\' affiliate links with its own and showed shoppers limited coupon options at partner stores. PayPal responded that "Honey follows industry rules and practices, including last-click attribution."',
        sources: ['usaToday', 'fortune'],
    },
    {
        date: '2025-03-11',
        text: 'Google announces a Chrome Web Store policy: an extension may add an affiliate link, code or cookie only when it gives the user a direct, transparent benefit, and only after a related user action. Enforcement began on June 10, 2025.',
        sources: ['chromePolicyBlog', 'chromePolicy'],
    },
    {
        date: '2025-03-12',
        text: 'By this date Honey\'s Chrome Web Store listing carries the disclosure "When you use PayPal Honey, merchants may pay us affiliate commissions." It is still there in September 2026.',
        sources: ['honeyDisclosure', 'honeyChrome'],
    },
    {
        date: '2025-11-21',
        text: "In the creators' class action against PayPal over Honey (Wendover Productions v. PayPal, N.D. Cal., case 5:24-cv-09470), the court dismisses the first amended complaint with leave to amend, because it did not plausibly show an injury traceable to PayPal.",
        sources: ['courtOrder2025'],
    },
    {
        date: '2026-06-22',
        text: "The same court denies PayPal's motion to dismiss the second amended complaint, so the creators' claims go forward. This is a ruling on the pleadings, not a finding that PayPal did anything wrong.",
        sources: ['courtOrder2026'],
    },
    {
        date: '2026-09-26',
        text: 'Honey is still a live PayPal product: its Chrome Web Store listing shows 13,000,000 users and an update on September 8, 2026.',
        sources: ['honeyChrome'],
    },
]

export type ComparisonFaqItem = { question: string; answer: string }

export const COMPARISON_FAQ: ReadonlyArray<ComparisonFaqItem> = [
    {
        question: 'What is the best coupon extension?',
        answer: 'It depends on what you want in return. For cash back, Rakuten, Capital One Shopping, Coupert and Honey share merchant commissions with you as rewards. To use codes without an account, SimplyCodes says none is needed and Caramel needs none. For an extension you can audit that never touches affiliate links, Caramel is the only one of these that publishes its source code, and it contains no affiliate code.',
    },
    {
        question: 'SimplyCodes vs Honey: which is better?',
        answer: "They work alike: both are free, both find and apply codes at checkout, and both earn commissions from merchants. SimplyCodes says you don't need an account to use its codes and rewards you in tokens; Honey rewards you through PayPal Rewards and is far larger, with 13,000,000 Chrome Web Store users against SimplyCodes' 90,000 (September 26, 2026). Neither publishes its source code.",
    },
    {
        question: 'Do coupon extensions make money from affiliate links?',
        answer: 'Most do. Honey, Capital One Shopping, SimplyCodes, Rakuten and Coupert each state on their own site or store listing that stores pay them commissions on sales. Caramel is the exception: its extension contains no affiliate code.',
    },
    {
        question:
            'Is there an alternative to Capital One Shopping that needs no account?',
        answer: "Yes. SimplyCodes states that you don't need an account to find and use its codes (one is only needed to earn tokens), and Caramel needs no account at all. Capital One Shopping itself doesn't require you to be a Capital One bank customer, and pays its rewards as Capital One Shopping Rewards.",
    },
    {
        question: 'Is Honey still available in 2026?',
        answer: 'Yes. PayPal Honey is still on the Chrome Web Store, where its listing showed 13,000,000 users and a September 8, 2026 update when checked on September 26, 2026. It is also listed for Edge and Safari; its Firefox add-on was last updated in February 2021.',
    },
    {
        question: 'Is there an open-source coupon extension?',
        answer: "Yes. Caramel's extension and website are open source under the AGPL-3.0 license and published on GitHub, so anyone can check what the extension sends and that it contains no affiliate code. None of the other extensions compared here publishes its source code.",
    },
]

/** Every cited source in first-citation order (table rows, then the
 *  timeline): the page numbers its footnotes by this order. */
export function comparisonSourceOrder(): ComparisonSourceId[] {
    const order: ComparisonSourceId[] = []
    for (const cited of [
        ...COMPARED_EXTENSIONS.map(row => row.sources),
        ...HONEY_TIMELINE.map(event => event.sources),
    ]) {
        for (const id of cited) if (!order.includes(id)) order.push(id)
    }
    return order
}
