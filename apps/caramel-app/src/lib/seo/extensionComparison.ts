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
// Money wording follows the vendors' own hedges ("stores may pay us"), per
// vendor: SimplyCodes discloses commissions on purchases "through links on
// SimplyCodes", which is not the same as stores paying it for extension use.
// The account column reports only what each vendor's own how-to shows, never
// that an account is REQUIRED, and per store where the how-tos differ
// (Coupert's Chrome listing has no sign-up step; Firefox and Safari do).
// Competitors' source code is "None found", never "Not published": a
// negative can't be cited.
//
// Deliberately NOT claimed (tempting, unverified on 2026-09-26): that Rakuten's
// extension was pulled from Chrome (its install link showed "This item is not
// available" from Canada; could be regional); that SimplyCodes needs no
// account (its site blocks automated reads and no store listing says so);
// Edge builds of SimplyCodes and Coupert (the Edge store page only renders in
// a browser); that Honey stopped earning commissions when no code applies;
// any Honey user-loss or merchant-count figure; other affiliate networks
// dropping Honey. PayPal's "merchants ultimately decide" line is USA TODAY's
// reported speech, so it is attributed to USA TODAY, never quoted.
//
// Vendor help centers lag their products: the first draft of this page took
// SimplyCodes' token rewards from its help pages, but its August 2026 release
// notes had already removed them. Prefer release notes and store listings,
// and re-check every row before changing COMPARISON_CHECKED_ON.
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
    simplyCodesChrome: {
        title: 'SimplyCodes',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/gfkpklgmocbcbdabfellcnikamdaeajd',
    },
    simplyCodesFirefoxVersions: {
        title: 'SimplyCodes version history (release notes for 2.10.0, August 3, 2026)',
        publisher: 'Firefox Add-ons',
        url: 'https://addons.mozilla.org/en-US/firefox/addon/simplycodes/versions/',
    },
    simplyCodesSafari: {
        title: 'SimplyCodes: Coupons & Rewards',
        publisher: 'Mac App Store',
        url: 'https://apps.apple.com/us/app/simplycodes-coupons-rewards/id1538885494',
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
    coupertMoney: {
        title: 'How Coupert Makes Money?',
        publisher: 'Coupert Help Center',
        url: 'https://help.coupert.com/platform-products/coupert-extension-faq/how-coupert-makes-money/',
    },
    coupertChrome: {
        title: 'Coupert',
        publisher: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/mfidniedemcgceagapgdekdbmanojomk',
    },
    coupertFirefox: {
        title: 'Coupert',
        publisher: 'Firefox Add-ons',
        url: 'https://addons.mozilla.org/en-US/firefox/addon/coupert/',
    },
    coupertSafari: {
        title: 'Coupert: Automatic Coupons',
        publisher: 'Mac App Store',
        url: 'https://apps.apple.com/us/app/coupert-automatic-coupons/id1531442936',
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
    /** What the vendor's own how-to shows about an account. */
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
        revenue: 'Says merchants may pay it affiliate commissions',
        rewards: 'PayPal Rewards points',
        account: 'Signing up is the first step in its help guide',
        browsers:
            'Chrome, Edge, Safari, Opera; Firefox listing last updated February 2021',
        sourceCode: 'None found',
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
        account: 'Its promo-code steps include creating an account',
        browsers: 'Chrome, Firefox, Edge, Safari',
        sourceCode: 'None found',
        sources: ['capitalOneHelp', 'capitalOneChrome'],
    },
    {
        name: 'SimplyCodes',
        maker: 'Demand.io',
        price: 'Free',
        revenue: 'Says it may earn a commission when you buy through its links',
        rewards: 'Tokens and prize bags, removed in August 2026',
        account: 'Not stated in its store listings',
        browsers: 'Chrome, Firefox, Safari',
        sourceCode: 'None found',
        sources: [
            'simplyCodesChrome',
            'simplyCodesFirefoxVersions',
            'simplyCodesSafari',
        ],
    },
    {
        name: 'Rakuten',
        maker: 'Rakuten',
        price: 'Free',
        revenue: 'Store commissions, part shared as Cash Back',
        rewards: 'Rakuten Cash Back',
        account: 'Cash Back is tracked in your Rakuten account',
        browsers: 'Chrome, Edge, Firefox, Safari (as Rakuten lists them)',
        sourceCode: 'None found',
        sources: ['rakutenHowItWorks', 'rakutenExtension'],
    },
    {
        name: 'Coupert',
        maker: 'Coupert',
        price: 'Free; Coupert Pure is a separate paid version with a 3-day free trial',
        revenue:
            'Free extension: affiliate commissions from stores, shared as Cash Back. Coupert Pure says it has no merchant ties',
        rewards: 'Cash Back',
        account:
            'Firefox and Safari how-tos have you sign up or log in; on Chrome, signing in is for tracking and withdrawing Cash Back',
        browsers: 'Chrome, Firefox, Safari',
        sourceCode: 'None found',
        sources: [
            'coupertFree',
            'coupertMoney',
            'coupertChrome',
            'coupertFirefox',
            'coupertSafari',
            'coupertPureChrome',
        ],
    },
]

/** The opening answer: what an answer engine should be able to quote alone. */
export const COMPARISON_SUMMARY =
    'Every coupon extension compared here is free to install. What differs is how each makes money, what it asks of you, and whether you can check what it does. Honey, Capital One Shopping, Rakuten and Coupert each say stores may pay them commissions when you shop with them, and share part of that back as rewards; SimplyCodes says it may earn a commission when you buy through its links. Caramel contains no affiliate code, has no rewards program, and publishes its source code; we found no published source code for the others.'

export type ComparisonPick = { need: string; answer: string }

/** "Which one should you use?": each answer follows from the table rows. */
export const COMPARISON_PICKS: ReadonlyArray<ComparisonPick> = [
    {
        need: 'You want rewards or cash back',
        answer: 'Rakuten and Coupert pay Cash Back, and Capital One Shopping and Honey give rewards you redeem later (Capital One Shopping Rewards, PayPal Rewards points). SimplyCodes ended its token rewards in August 2026, and Caramel has no rewards program.',
    },
    {
        need: "You don't want an account",
        answer: "Caramel needs none. Honey's help guide starts with signing up, Capital One Shopping's promo-code steps include creating an account, and Coupert's Firefox and Safari how-tos have you sign up or log in.",
    },
    {
        need: 'You want to check what the extension does',
        answer: 'Caramel publishes its source code (AGPL-3.0), so what it does can be read rather than taken on trust. We found no published source code for the others.',
    },
    {
        need: "You buy through creators' links",
        answer: "Caramel contains no affiliate code, so it never adds or replaces a referral link or cookie. Honey, Capital One Shopping, Rakuten and the free Coupert extension say stores may pay them commissions when you shop with them, and SimplyCodes says it may earn a commission when you buy through its links; Coupert's paid Coupert Pure says it has no merchant ties or cookie overrides. The timeline below covers the lawsuit over Honey and creators' links.",
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
        text: 'YouTuber MegaLag publishes "Exposing the Honey Influencer Scam", alleging that Honey replaced creators\' affiliate links with its own and showed shoppers limited coupon options at partner stores. PayPal responded that "Honey follows industry rules and practices, including last-click attribution," and told USA TODAY that merchants ultimately decide which coupons are offered through Honey.',
        sources: ['usaToday', 'fortune'],
    },
    {
        date: '2025-03-11',
        text: 'Google announces a Chrome Web Store policy: an extension may add an affiliate link, code or cookie only when it gives the user a direct, transparent benefit, and only after a related user action. Google said enforcement would begin on June 10, 2025.',
        sources: ['chromePolicyBlog', 'chromePolicy'],
    },
    {
        date: '2025-03-12',
        text: 'By this date Honey\'s Chrome Web Store listing carries the disclosure "When you use PayPal Honey, merchants may pay us affiliate commissions." It is still there in September 2026.',
        sources: ['honeyDisclosure', 'honeyChrome'],
    },
    {
        date: '2025-11-21',
        text: 'In a proposed class action brought by creators against PayPal over Honey (Wendover Productions v. PayPal, N.D. Cal., case 5:24-cv-09470), the court dismisses the first amended complaint with leave to amend, because it did not plausibly show an injury traceable to PayPal.',
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
        answer: 'It depends on what you want in return. For cash back, Rakuten and Coupert pay Cash Back, and Capital One Shopping and Honey give rewards you redeem later. For an extension that needs no account and whose behavior you can check yourself, Caramel publishes its source code and contains no affiliate code.',
    },
    {
        question: 'SimplyCodes vs Honey: which is better?',
        answer: "Both are free and both surface coupon codes at checkout: Honey says it looks for and applies them automatically, while SimplyCodes shows verified codes and leaves you in control. Both say they may earn commissions. Honey pays PayPal Rewards points; SimplyCodes removed its token rewards in August 2026, saying they never made the codes better. Honey is also far larger, with 13,000,000 Chrome Web Store users against SimplyCodes' 90,000 (September 26, 2026). We found no published source code for either.",
    },
    {
        question: 'Do coupon extensions make money from affiliate links?',
        answer: "Most do. Honey, Capital One Shopping, Rakuten and the free Coupert extension each say on their own site or store listing that stores may pay them commissions when you shop with them, and SimplyCodes says it may earn a commission when you buy through its links. The exceptions here are Caramel, whose extension contains no affiliate code, and Coupert's paid Coupert Pure, which says it has no merchant ties.",
    },
    {
        question:
            'Is there an alternative to Capital One Shopping that needs no account?',
        answer: "Yes. Caramel finds and applies coupon codes with no account at all. Capital One Shopping's own promo-code steps include creating an account (you don't need to be a Capital One bank customer), and it pays its rewards as Capital One Shopping Rewards.",
    },
    {
        question: 'Is Honey still available in 2026?',
        answer: 'Yes. PayPal Honey is still on the Chrome Web Store, where its listing showed 13,000,000 users and a September 8, 2026 update when checked on September 26, 2026. It is also listed for Edge and Safari; its Firefox add-on was last updated in February 2021.',
    },
    {
        question: 'Is there an open-source coupon extension?',
        answer: "Yes. Caramel's extension and website are open source under the AGPL-3.0 license and published on GitHub, so anyone can check what the extension sends and that it contains no affiliate code. We found no published source code for the other extensions compared here.",
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
