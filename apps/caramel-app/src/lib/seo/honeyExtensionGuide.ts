// The Honey extension guide, as data. ONE module feeds the page at
// /honey-extension, its FAQPage JSON-LD and its section of /llms-full.txt.
//
// Why it exists: Search Console (28 days to 2026-10-02) shows the generic
// Honey queries landing on the home page, which answers none of them, at
// page-two positions: "honey extension" (133 impressions, p13.9), "honey
// coupons" (118, p9.9), "honey coupon" (76, p14.4), "honey chrome extension"
// (70, p17.5), "honey coupon extension" (55, p16.7). The 2026-10-05 SERPs
// for them are informational (Wikipedia, review sites, the 2024 controversy
// coverage), not stores. The home page already ranks 1-2 for "honey
// alternative", so, like /compare/coupon-extensions, this page keeps that
// phrase out of its title and h1 and links the home page with it instead.
//
// CLAIM INTEGRITY: no new competitor facts live here. Every statement about
// Honey is the Honey row, timeline or sources of extensionComparison.ts
// (read on COMPARISON_CHECKED_ON, with that module's "deliberately NOT
// claimed" list), so the two pages cannot disagree. A new Honey fact goes
// into extensionComparison.ts first, with its source.
import {
    COMPARED_EXTENSIONS,
    COMPARISON_FAQ,
    type ComparedExtension,
    type ComparisonFaqItem,
    type ComparisonSourceId,
    HONEY_TIMELINE,
} from '@/lib/seo/extensionComparison'

export const HONEY_GUIDE_PATH = '/honey-extension'

function compared(name: string): ComparedExtension {
    const row = COMPARED_EXTENSIONS.find(candidate => candidate.name === name)
    if (!row) {
        throw new Error(
            `honeyExtensionGuide: no "${name}" row in COMPARED_EXTENSIONS`,
        )
    }
    return row
}

// PURE: the Footer imports HONEY_GUIDE_PATH from this module into the client
// bundle, and the annotations let the bundler drop the unused page data.
export const HONEY_ROW = /*#__PURE__*/ compared('Honey')
export const CARAMEL_ROW = /*#__PURE__*/ compared('Caramel')

/** The opening answer: what an answer engine should be able to quote alone. */
export const HONEY_GUIDE_SUMMARY =
    "Honey is a free browser extension from PayPal that looks for coupon codes at checkout and applies them for you. It is still available in 2026. It says merchants may pay it affiliate commissions when you use it, and it gives PayPal Rewards points. Since December 2024 it has faced allegations that it replaced creators' affiliate links with its own, and a proposed class action brought by creators over Honey is going forward in a U.S. federal court."

/** The sources behind HONEY_GUIDE_SUMMARY, footnoted right after it. */
export const HONEY_GUIDE_SUMMARY_SOURCES: ReadonlyArray<ComparisonSourceId> = [
    'honeyHelpWhat',
    'honeyChrome',
    'honeyHelpMoney',
    'fortune',
    'courtOrder2026',
]

/** Rows of the "Honey and Caramel side by side" table, read from the
 *  comparison rows so the two pages state the same thing. */
export const HONEY_VS_CARAMEL: ReadonlyArray<{
    label: string
    honey: string
    caramel: string
}> = [
    { label: 'Made by', honey: HONEY_ROW.maker, caramel: CARAMEL_ROW.maker },
    { label: 'Price', honey: HONEY_ROW.price, caramel: CARAMEL_ROW.price },
    {
        label: 'How it makes money',
        honey: HONEY_ROW.revenue,
        caramel: CARAMEL_ROW.revenue,
    },
    {
        label: 'Rewards',
        honey: HONEY_ROW.rewards,
        caramel: CARAMEL_ROW.rewards,
    },
    {
        label: 'Account',
        honey: HONEY_ROW.account,
        caramel: CARAMEL_ROW.account,
    },
    {
        label: 'Browsers',
        honey: HONEY_ROW.browsers,
        caramel: CARAMEL_ROW.browsers,
    },
    {
        label: 'Source code',
        honey: HONEY_ROW.sourceCode,
        caramel: CARAMEL_ROW.sourceCode,
    },
]

export type HoneyGuideFaqItem = ComparisonFaqItem & {
    sources: ReadonlyArray<ComparisonSourceId>
}

function comparisonAnswer(question: string): string {
    const item = COMPARISON_FAQ.find(
        candidate => candidate.question === question,
    )
    if (!item) {
        throw new Error(
            `honeyExtensionGuide: no "${question}" in COMPARISON_FAQ`,
        )
    }
    return item.answer
}

export const HONEY_GUIDE_FAQ: ReadonlyArray<HoneyGuideFaqItem> = [
    {
        question: 'What is the Honey extension?',
        answer: "Honey is a free browser extension made by PayPal. When you reach a store's checkout, it looks for coupon codes and applies them automatically. Its rewards are PayPal Rewards points.",
        sources: ['honeyHelpWhat', 'honeyChrome'],
    },
    {
        question: 'How does the Honey extension make money?',
        answer: 'Honey says merchants may pay it affiliate commissions when you use it. Its Chrome Web Store listing has carried the line "When you use PayPal Honey, merchants may pay us affiliate commissions." since at least March 12, 2025.',
        sources: ['honeyHelpMoney', 'honeyDisclosure', 'honeyChrome'],
    },
    {
        question: 'What are the concerns about the Honey extension?',
        answer: "In December 2024 a YouTuber alleged that Honey replaced creators' affiliate links with its own and showed shoppers limited coupon options at partner stores. PayPal said Honey follows industry rules, including last-click attribution. A proposed class action brought by creators over this survived a motion to dismiss on June 22, 2026; that is a ruling on the pleadings, not a finding that PayPal did anything wrong.",
        sources: ['usaToday', 'fortune', 'courtOrder2026'],
    },
    {
        question: 'Is Honey still available in 2026?',
        answer: /*#__PURE__*/ comparisonAnswer(
            'Is Honey still available in 2026?',
        ),
        sources: ['honeyChrome', 'honeyFirefox', 'honeyHelpWhat'],
    },
    {
        question: 'Do you need an account to use Honey?',
        answer: "Signing up is the first step in Honey's own help guide for getting the extension. Caramel, by comparison, needs no account at all.",
        sources: ['honeyHelpWhat', 'caramelSource'],
    },
    {
        question: 'Is Honey available for Firefox?',
        answer: 'Honey has a Firefox add-on, but its listing on Firefox Add-ons was last updated in February 2021, while its Chrome Web Store listing was updated on September 8, 2026. Caramel ships the same extension for Firefox as for Chrome, Edge and Safari.',
        sources: ['honeyFirefox', 'honeyChrome', 'caramelSource'],
    },
    {
        question: 'How is Caramel different from Honey?',
        answer: 'Both find and apply coupon codes at checkout. Caramel contains no affiliate code, so it never adds or replaces a referral link or cookie; it has no rewards program, needs no account, and publishes its source code under the AGPL-3.0 license so anyone can check what it does. It runs on Chrome, Firefox, Edge and Safari.',
        sources: ['caramelSource', 'honeyHelpWhat'],
    },
]

/** Every source this page cites, in first-citation order (summary, side-by-side
 *  rows, then the timeline, then the FAQ): the page numbers its footnotes by it. */
export function honeyGuideSourceOrder(): ComparisonSourceId[] {
    const order: ComparisonSourceId[] = []
    for (const cited of [
        HONEY_GUIDE_SUMMARY_SOURCES,
        HONEY_ROW.sources,
        CARAMEL_ROW.sources,
        ...HONEY_TIMELINE.map(event => event.sources),
        ...HONEY_GUIDE_FAQ.map(item => item.sources),
    ]) {
        for (const id of cited) if (!order.includes(id)) order.push(id)
    }
    return order
}
