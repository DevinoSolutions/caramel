// Landing-page body copy extracted verbatim; shared by the existing sections
// and the Markdown twin. Presentation and metadata remain in their components.
import {
    CHROME_WEB_STORE_URL,
    DISCORD_INVITE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    GITHUB_REPO_URL,
    INSTAGRAM_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'

export const HOME_HERO_COPY = {
    welcome: 'Welcome to',
    summaryStart: 'The',
    openSource: 'open-source',
    and: 'and',
    privacyFirst: 'privacy-first',
    summaryMain:
        'alternative to Honey. Automatically finds and applies the best coupon codes at checkout —',
    withoutSelling: 'without selling your data',
    or: 'or',
    commissions: 'hijacking creatorsʼ commissions',
    install: 'Install Extension',
} as const

export const HOME_WORDMARK_ALT = 'Caramel — the open-source coupon extension'

export const HOME_FEATURES = [
    {
        title: 'Automated Coupon Application',
        desc: 'Saves you money by finding and applying the best coupon codes.',
        detail: 'We monitor thousands of coupon codes across 4,000+ stores, ensuring you always get the best deal without lifting a finger.',
    },
    {
        title: 'Privacy-First & Transparent',
        desc: 'Your data stays yours. We never sell or monetize your personal information.',
        detail: 'Unlike other extensions, we never sell your data, build ad profiles, or hijack affiliate commissions from content creators.',
    },
    {
        title: '100% Open Source',
        desc: 'Our extension and web app are fully public and community-driven.',
        detail: 'Join our GitHub to contribute features, report issues, or request enhancements. Reviewed in the open by contributors and the community.',
    },
    {
        title: 'Creator-Friendly',
        desc: 'We never overwrite affiliate links or steal commissions.',
        detail: 'Support your favorite content creators while saving money. We ensure affiliate links stay with their rightful owners.',
    },
    {
        title: 'Fast & Lightweight',
        desc: 'Automatic coupon discovery and application at checkout.',
        detail: 'Our optimized algorithms search and apply coupons at checkout, never slowing down your shopping experience.',
    },
    {
        title: 'Cross-Browser Support',
        desc: 'Works seamlessly across Chrome, Firefox, and more.',
        detail: 'One extension for Chrome, Firefox, Edge, and Safari. Consistent experience regardless of your browser preference with automatic updates.',
    },
] as const

export const HOME_COMPARISONS = [
    {
        title: 'Privacy Protection',
        other: 'Often opaque data practices',
        caramel: '100% privacy-first approach',
    },
    {
        title: 'Data Collection',
        other: 'May track your browsing habits',
        caramel: 'No ad tracking or data selling',
    },
    {
        title: 'Creator Support',
        other: 'Hijacked affiliate commissions',
        caramel: 'Protects creator earnings',
    },
    {
        title: 'Code Transparency',
        other: 'Closed source & hidden',
        caramel: 'Fully open source & publicly reviewable',
    },
    {
        title: 'Performance',
        other: 'Often resource-heavy',
        caramel: 'Fast & lightweight',
    },
] as const

export const HOME_FEATURES_COPY = {
    heading: 'Why Choose Caramel?',
    summary:
        'The ethical alternative that puts your privacy first while maximizing your savings',
    comparisonHeading: 'Caramel vs Others',
    comparisonSummary:
        'See how we stack up against traditional coupon extensions',
    otherHeading: 'Other Extensions',
    caramelHeading: 'Caramel',
    browsersHeading: 'Available on Your Favorite Browser!',
    browsersSummary: 'Start saving with Caramel on any browser!',
} as const

export const HOME_FEATURED_STORES = [
    {
        name: 'Amazon',
        domain: 'amazon.com',
        desc: 'Worldʼs largest online retailer',
        image: '/amazon.png',
        category: 'marketplace',
    },
    {
        name: 'eBay',
        domain: 'ebay.com',
        desc: 'Auction marketplace for buyers & sellers',
        image: '/home-stores/ebay.webp',
        category: 'marketplace',
    },
    {
        name: 'Codecademy',
        domain: 'codecademy.com',
        desc: 'Interactive platform to learn coding',
        image: '/home-stores/codeAcademy.webp',
        category: 'education',
    },
    {
        name: 'Best Buy',
        domain: 'bestbuy.com',
        desc: 'Electronics and tech retailer',
        image: '/home-stores/bestbuy.webp',
        category: 'electronics',
    },
    {
        name: 'Target',
        domain: 'target.com',
        desc: 'Department store chain',
        image: '/target.png',
        category: 'retail',
    },
    {
        name: 'Walmart',
        domain: 'walmart.com',
        desc: 'Multinational retail corporation',
        image: '/home-stores/walmart.webp',
        category: 'retail',
    },
    {
        name: 'Nike',
        domain: 'nike.com',
        desc: 'Athletic footwear and apparel',
        image: '/home-stores/nike.webp',
        category: 'fashion',
    },
    {
        name: 'Adidas',
        domain: 'adidas.com',
        desc: 'Sports clothing and accessories',
        image: '/home-stores/adidas.webp',
        category: 'fashion',
    },
] as const

export const HOME_STORES_COPY = {
    heading: '4,000+ Supported Stores',
    summary:
        'From major retailers to niche marketplaces, Caramel works at thousands of stores.',
    requestHeading: 'Donʼt See Your Favorite Store?',
    requestSummary:
        'Weʼre constantly adding new stores to our platform. Request yours today!',
} as const

export const HOME_HONEY_PROBLEMS = [
    {
        title: 'Affiliate Link Hijacking',
        desc: "Honey was documented replacing creators' affiliate links with its own (MegaLag, December 2024), taking commissions from content creators you want to support",
    },
    {
        title: 'Hidden Data Collection',
        desc: 'Your browsing data, purchase history, and personal information is reportedly collected without clear disclosure',
    },
    {
        title: 'Creator Revenue Loss',
        desc: 'YouTubers, bloggers, and influencers lost rightful earnings when Honey overrode their referral links',
    },
    {
        title: 'Closed Source Operation',
        desc: "You can't verify what Honey actually does behind the scenes - their code is closed source, with nothing published for independent audit",
    },
] as const

export const HOME_HONEY_SOLUTIONS = [
    {
        title: 'Respects Creator Links',
        desc: 'We never override affiliate links - creators keep 100% of their rightful commissions',
    },
    {
        title: 'No Data Selling',
        desc: 'Your browsing habits stay private - we never sell your personal information or share it with advertisers',
    },
    {
        title: 'Supports Content Creators',
        desc: 'Help sustain the creators you love while still getting the best deals available',
    },
    {
        title: 'Fully Open Source',
        desc: 'The extension and web app are public and auditable under the AGPL-3.0 license - see exactly what the extension does',
    },
] as const

export const HOME_HONEY_COPY = {
    heading: 'Why Not Just Use Honey?',
    comparisonHeading: 'Honey vs Caramel',
    comparisonSummary:
        'The documented problems with Honey — and what Caramel does instead',
    switchHeading: 'Make the Switch to Caramel',
    switchSummary:
        'Join thousands of users whoʼve made the switch to Caramel. Save money while supporting the creators you love, all with complete transparency and privacy protection.',
} as const

export const HOME_PLATFORMS = [
    {
        name: 'GitHub',
        href: GITHUB_REPO_URL,
        desc: 'Explore our open-source code & contribute',
        color: 'from-gray-600 to-gray-800',
    },
    {
        name: 'Discord',
        href: DISCORD_INVITE_URL,
        desc: 'Join our developer community',
        color: 'from-indigo-500 to-purple-600',
    },
    {
        name: 'Instagram',
        href: INSTAGRAM_URL,
        desc: 'Follow us for updates & tips',
        color: 'from-pink-500 to-rose-500',
    },
] as const

export const HOME_CONTRIBUTIONS = [
    {
        title: 'Code Contributions',
        desc: 'Help improve our algorithms, add new features, or fix bugs',
        action: 'Start Contributing',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=enhancement&projects=&template=feature-request.md&title=%5BFeature%5D+',
    },
    {
        title: 'Store Requests',
        desc: 'Request support for new e-commerce platforms and stores',
        action: 'Request Store',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=store-request&projects=&template=store-request.md&title=%5BStore+Request%5D+Add+support+for+',
    },
    {
        title: 'Bug Reports',
        desc: 'Help us identify and fix issues to improve user experience',
        action: 'Report Bug',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=bug&projects=&template=bug-report.md&title=%5BBug%5D+',
    },
    {
        title: 'Feature Ideas',
        desc: 'Suggest new features that would benefit the community',
        action: 'Suggest Feature',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=enhancement&projects=&template=feature-request.md&title=%5BFeature%5D+',
    },
] as const

export const HOME_SECURITY_FEATURES = [
    {
        title: 'Open Security Reviews',
        desc: 'Every change is publicly reviewable',
    },
    {
        title: 'Transparent Operations',
        desc: 'All code changes are public and reviewable',
    },
    {
        title: 'No Ad Tracking',
        desc: 'We never sell your personal information or share it with advertisers',
    },
    {
        title: 'Community Oversight',
        desc: 'Anyone in the world can audit our code',
    },
] as const

export const HOME_OPEN_SOURCE_COPY = {
    heading: 'Open Source & Community Driven',
    summary:
        'Transparency is our core. The extension and web app are open, auditable, and community-driven. Join the developers building a better alternative to proprietary extensions.',
    securityHeading: 'Security Through Transparency',
    communityHeading: 'Connect With Our Community',
    contributionHeading: 'Contribution Pathways',
    actionHeading: 'Ready to Make a Difference?',
    actionSummary:
        'Join our mission to create ethical, transparent, and user-first shopping tools. Your contribution, no matter how small, helps build a better internet for everyone.',
} as const

export const HOME_BROWSERS = [
    {
        name: 'Chrome',
        href: CHROME_WEB_STORE_URL,
        available: true,
    },
    {
        name: 'Safari',
        href: SAFARI_APP_STORE_URL,
        available: true,
    },
    {
        name: 'Firefox',
        href: FIREFOX_ADDONS_URL,
        available: true,
    },
    {
        name: 'Edge',
        href: EDGE_ADDONS_URL,
        available: true,
    },
] as const
