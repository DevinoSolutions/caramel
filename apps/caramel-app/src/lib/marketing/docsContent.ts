// /docs hub copy, as data. ONE module feeds the HTML page
// ((marketing)/docs/page.tsx) and its Markdown twin (markdownTwins/
// staticPages.ts), so the twin can never advertise a sentence the page does
// not render.
//
// CLAIM INTEGRITY (written 2026-10-24, T-7855): every sentence below restates
// a fact that already ships on another surface, named per section. Nothing
// here is new product copy. When one of those sources changes, change it here
// too:
// - what is Caramel / how it works / machine-readable: llms.txt + llms-full.txt
// - catalog size, shopper-shared codes, data handling: src/lib/faqItems.ts
// - supported stores: (marketing)/supported-stores/page.tsx description
// - sources: (marketing)/sources/page.tsx description
// - agent setup: (marketing)/agent-setup/page.tsx + agentSetup.config.ts
// - support: (marketing)/support/page.tsx ("a human replies within 1 business
//   day"), .well-known/security.txt (Contact: the support page)
// - install links: src/lib/brandLinks.ts
import {
    CHROME_WEB_STORE_URL,
    DISCORD_INVITE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    GITHUB_REPO_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'

export const DOCS_PATH = '/docs'

export const DOCS_PAGE_COPY = {
    title: 'Caramel Docs — install, privacy, support and agent setup',
    description:
        'Documentation hub for the free, open-source Caramel coupon extension: install it on Chrome, Firefox, Edge or Safari, how codes are found, privacy, support, and machine-readable resources for AI agents.',
    heading: 'Caramel documentation',
    summary:
        'Everything about the free, open-source Caramel coupon extension in one place: how to install it, how it finds and tests codes, what it does with your data, how to reach a human, and the machine-readable resources for AI agents.',
    contentsLabel: 'On this page',
} as const

export type DocsLink = {
    label: string
    /** A site path ("/faq") or an absolute URL. */
    href: string
    description?: string
    /**
     * Not an HTML page (text, JSON, XML, Markdown): the page renders a plain
     * anchor instead of a client-navigated next/link.
     */
    resource?: true
}

export type DocsSection = {
    id: string
    heading: string
    paragraphs: ReadonlyArray<string>
    /** Rendered as an ordered list after the paragraphs. */
    steps?: ReadonlyArray<string>
    links: ReadonlyArray<DocsLink>
}

export const DOCS_SECTIONS: ReadonlyArray<DocsSection> = [
    {
        id: 'what-is-caramel',
        heading: 'What Caramel is',
        paragraphs: [
            'Caramel is a free, open-source, privacy-first browser extension that finds and applies coupon codes automatically at checkout. It does not sell browsing data and does not overwrite creators’ affiliate commissions.',
            'It is free to use, with no paid tier and no account required to install. It is open source under the AGPL-3.0 license, built and maintained by Devino Solutions together with community contributors.',
        ],
        links: [
            {
                label: 'Source code on GitHub',
                href: GITHUB_REPO_URL,
            },
            {
                label: 'Pricing',
                href: '/pricing',
                description: 'the plan structure: Caramel is free',
            },
            {
                label: 'FAQ',
                href: '/faq',
                description: 'the questions shoppers actually ask, answered',
            },
        ],
    },
    {
        id: 'install',
        heading: 'Install',
        paragraphs: [
            'Caramel is available for Chrome, Firefox, Microsoft Edge and Safari. Pick the store listing for your browser; no account is needed to install.',
            'The Safari version ships through the App Store for Mac and for iPhone and iPad, and it is free there like every other version.',
        ],
        links: [
            {
                label: 'Chrome',
                href: CHROME_WEB_STORE_URL,
                description: 'Chrome Web Store',
            },
            {
                label: 'Firefox',
                href: FIREFOX_ADDONS_URL,
                description: 'Firefox Add-ons',
            },
            {
                label: 'Microsoft Edge',
                href: EDGE_ADDONS_URL,
                description: 'Microsoft Edge Add-ons',
            },
            {
                label: 'Safari',
                href: SAFARI_APP_STORE_URL,
                description: 'App Store',
            },
            {
                label: 'All download options',
                href: '/apps',
                description:
                    'the official store badges and what the installed extension does on each browser',
            },
        ],
    },
    {
        id: 'how-codes-are-found-and-tested',
        heading: 'How codes are found and tested',
        paragraphs: ['Caramel works in four steps while you shop:'],
        steps: [
            'You shop normally; Caramel detects a supported store’s checkout page.',
            'It looks up known coupon codes for that store from its own catalog.',
            'It tries the codes at checkout and keeps the one with the best discount.',
            'It reports whether a code worked so the catalog’s rankings stay accurate.',
        ],
        links: [
            {
                label: 'Sources',
                href: '/sources',
                description:
                    'where Caramel’s coupon codes come from, and where to request a new source',
            },
            {
                label: 'Coupons',
                href: '/coupons',
                description: 'browse the full coupon catalog',
            },
        ],
    },
    {
        id: 'supported-stores',
        heading: 'Supported stores',
        paragraphs: [
            'Caramel’s catalog holds over 100,000 coupon codes across more than 4,000 online stores, and it is refreshed continuously as new codes are found and dead ones are retired.',
            'You can search the supported stores, browse them A to Z, or open a store’s own page (for example /coupons/amazon.com) to see its codes.',
        ],
        links: [
            {
                label: 'Supported stores',
                href: '/supported-stores',
                description:
                    'search the stores and see the ones added most recently',
            },
            {
                label: 'Store directory A–Z',
                href: '/coupons/stores',
                description: 'every store with live codes, by first letter',
            },
        ],
    },
    {
        id: 'ai-agents',
        heading: 'Using Caramel with an AI agent',
        paragraphs: [
            'Paste one sentence into Claude Code, Codex, Cursor, OpenCode or GitHub Copilot and it installs the Caramel coupon skill and verifies the public coupon API. No API key and no account are needed.',
            'The coupon API is public, unauthenticated, read-only JSON: query it with ?site=<domain> or ?search=<text>, and resolve store domains with /api/coupons/stores?q=<prefix>. There is no Caramel MCP server or SDK; the browser extension itself is for you to install.',
        ],
        links: [
            {
                label: 'Agent setup',
                href: '/agent-setup',
                description:
                    'the sentence to paste, and a guide for each supported agent',
            },
            {
                label: 'Agent setup instructions (Markdown)',
                href: '/agent-setup/prompt.md',
                description:
                    'the machine-readable instructions an agent follows',
                resource: true,
            },
            {
                label: 'Coupon API',
                href: '/api/coupons',
                description: 'public, read-only JSON',
                resource: true,
            },
        ],
    },
    {
        id: 'privacy-and-data',
        heading: 'Privacy and data',
        paragraphs: [
            'Caramel never sells personal information and shares it only with the service providers named in its privacy policy, and ships no ads and no third-party trackers.',
            'The extension talks only to Caramel’s own servers: at checkout on a supported store it fetches coupon codes for that store’s domain, sends page and cart context (page title and item names, never payment details) so the right category of codes is chosen, and reports whether a code worked. Settings and the optional sign-in are kept in the browser’s extension storage.',
            'Sharing a code you typed at checkout is off by default and happens only if you agree.',
        ],
        links: [
            {
                label: 'Privacy policy',
                href: '/privacy',
                description: 'what data Caramel does and does not collect',
            },
        ],
    },
    {
        id: 'support',
        heading: 'Support',
        paragraphs: [
            'Report a problem, request a feature, or ask a question on the support page. Tick “I’d like a reply” and a human replies within 1 business day.',
            'Security reports use the same support page; /.well-known/security.txt points there.',
        ],
        links: [
            {
                label: 'Contact support',
                href: '/support',
            },
            {
                label: 'Discord community',
                href: DISCORD_INVITE_URL,
                description:
                    'ask other shoppers and follow updates; for anything about your account, use the support form',
            },
        ],
    },
    {
        id: 'machine-readable-resources',
        heading: 'Machine-readable resources',
        paragraphs: [
            'Public pages with a Markdown alternate have a .md twin (this page: /docs.md; the home page: /index.md). Request a page with Accept: text/markdown to read the same content as Markdown.',
        ],
        links: [
            {
                label: 'llms.txt',
                href: '/llms.txt',
                description:
                    'the short index of what Caramel is and where to look',
                resource: true,
            },
            {
                label: 'llms-full.txt',
                href: '/llms-full.txt',
                description:
                    'the same facts plus the FAQ questions and answers and a privacy summary, in one document',
                resource: true,
            },
            {
                label: 'Markdown twin of this page',
                href: '/docs.md',
                resource: true,
            },
            {
                label: 'security.txt',
                href: '/.well-known/security.txt',
                description: 'how to report a security problem',
                resource: true,
            },
            {
                label: 'sitemap.xml',
                href: '/sitemap.xml',
                resource: true,
            },
        ],
    },
]

/** True when the link leaves the site (opens in a new tab, no client nav). */
export function isExternalDocsLink(href: string): boolean {
    return /^https?:\/\//.test(href)
}

/** The absolute URL for a link, for the Markdown twin (no relative links). */
export function absoluteDocsHref(href: string, origin: string): string {
    return isExternalDocsLink(href) ? href : `${origin}${href}`
}
