// Body copy extracted verbatim from PricingSection; HTML and Markdown share it.

export const PRICING_COPY = {
    headingPrefix: 'Simple, Transparent',
    headingEmphasis: 'Pricing',
    summary:
        'No tricks, no hidden fees. Caramel is completely free and always will be.',
    badge: 'ALWAYS FREE',
    planHeading: 'Free Forever Plan',
    planSummary:
        'Everything you need to save money while shopping online. No payment required, ever.',
    cta: "Get Started - It's Free",
    serial: 'CARAMEL-FREE-FOREVER',
    whyHeading: 'Why Is Caramel Free?',
    transparencyHeading: 'We believe in transparency.',
    transparency:
        'Unlike other extensions that monetize your data or hijack affiliate commissions, Caramel is built in the open, for the community.',
    openSourceHeading: '100% Open Source.',
    openSource:
        'Our extension and web app are public on GitHub. Anyone can audit, contribute, or fork the project. This transparency ensures we stay true to our mission.',
    privacyHeading: 'Your privacy matters.',
    privacy:
        'We never sell your data, build ad profiles, or serve ads. Caramel exists to save you money, not to profit from your information.',
} as const

export const PRICING_FEATURES: readonly string[] = [
    'Automated coupon application at checkout',
    'Works on 4,000+ supported stores',
    'Zero ads or data selling',
    'Open source & community-driven',
    'Never hijacks affiliate commissions',
    'Fast, lightweight performance',
    'Cross-browser support (Chrome, Firefox, Edge, iOS Safari)',
    'Regular updates & new features',
    'No credit card required',
    'No hidden fees ever',
]

export const PRICING_STATS: ReadonlyArray<{ title: string; desc: string }> = [
    {
        title: '$0',
        desc: 'Forever',
    },
    {
        title: '100%',
        desc: 'Open Source',
    },
    {
        title: '4,000+',
        desc: 'Stores Supported',
    },
]
