// Body copy shared by the HTML pages and their Markdown twins. Metadata and
// structured data stay in the pages; these strings preserve the visible copy.
import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'

export const GUIDE_BODY = {
    checkedOn: 'Checked on',
    timelineHeading: 'What happened with Honey',
    sourcesHeading: 'Sources',
    installBody:
        'Caramel finds and applies coupon codes at checkout. Free, no account, open source.',
} as const

export const HONEY_GUIDE_BODY = {
    heading: (year: number): string =>
        `The Honey extension in ${year}: what it does and what changed`,
    sourceNote:
        ". Every statement about Honey comes from PayPal's own help center, its browser store listings, the browser stores' own policies, court orders or named news outlets, numbered in the sources below. Caramel is our extension, so check those sources rather than taking our word for it.",
    tableHeading: 'Honey and Caramel side by side',
    installLead: 'Want one with no affiliate code?',
    faqHeading: 'Questions about the Honey extension',
    onwardBefore: 'Looking past Honey? See how ',
    homeLink: 'Caramel, the open-source Honey alternative',
    onwardBetween: ', works, or read ',
    comparisonLink: 'the best coupon extensions compared',
    onwardAfter:
        ' (Honey, Capital One Shopping, SimplyCodes, Rakuten and Coupert).',
} as const

export const COMPARISON_BODY = {
    heading: 'The best coupon extensions, compared',
    sourceNote:
        ". Every statement about another extension comes from its maker's own site, its browser store listing, a court filing or a named news outlet, numbered in the sources below. Caramel is our extension, so check those sources rather than taking our word for it.",
    tableHeading: 'Side by side',
    tableLabels: {
        name: 'Extension',
        price: 'Price',
        revenue: 'How it makes money',
        rewards: 'Rewards',
        account: 'Account, per its own guide',
        browsers: 'Browsers',
        sourceCode: 'Source code',
    },
    picksHeading: 'Which one should you use?',
    installLead: 'Want the one with no affiliate code?',
    honeyBefore:
        'What Honey does, how it makes money, and the controversy and lawsuit are explained in ',
    honeyLink: 'the Honey extension, explained',
    faqHeading: 'Questions people ask',
    onwardBefore: 'More about Caramel itself is in the ',
    faqLink: 'Caramel FAQ',
    onwardBetween: ', and the stores it has codes for are in the ',
    directoryLink: 'store directory',
} as const

export const COUPONS_BODY = {
    pageSize: 5,
    heading: "Today's Coupon Codes",
    summary:
        'Browse coupon codes, promo codes, and offers for your favorite stores.',
    sidebarDescription:
        "The open-source and privacy-first alternative to Honey. Automatically finds and applies the best coupon codes at checkout — without selling your data or hijacking creators' commissions.",
    emptyHeading: 'No coupons found',
    emptyBody: 'Try adjusting your filters',
    endHeading: "You've seen all available coupons.",
    endBody: 'Check back soon for more deals',
    browserHeading: 'Available on Your Favorite Browser',
    browserBody: 'Start saving with Caramel on any browser!',
    browsers: [
        { name: 'Chrome', href: CHROME_WEB_STORE_URL },
        { name: 'Safari', href: SAFARI_APP_STORE_URL },
        { name: 'Firefox', href: FIREFOX_ADDONS_URL },
        { name: 'Edge', href: EDGE_ADDONS_URL },
    ],
    supportedHeading: '4,000+ Supported Stores',
    supportedBody:
        'From major retailers to niche marketplaces, Caramel works at thousands of stores.',
    supportedLink: 'View All Supported Stores',
    popularHeading: 'Popular coupon stores',
} as const

export const DIRECTORY_BODY = {
    heading: 'All stores with coupon codes, A–Z',
    lettersHeading: 'Stores by first letter',
    browseHeading: 'Browse stores A–Z',
    allStores: 'All stores',
} as const

export function storeDirectorySummary(storeCount: number): string {
    return storeCount > 0
        ? `Caramel currently lists live coupon codes for ${storeCount.toLocaleString('en-US')} ${storeCount === 1 ? 'store' : 'stores'}. Pick a letter to see every store that starts with it and how many codes each one has right now.`
        : 'Caramel has no stores with live coupon codes right now — new codes are added automatically as they are found.'
}
