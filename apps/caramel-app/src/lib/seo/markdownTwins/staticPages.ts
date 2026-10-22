import { GITHUB_REPO_URL } from '@/lib/brandLinks'
import { faqItems } from '@/lib/faqItems'
import { FAQ_COPY } from '@/lib/marketing/faqContent'
import {
    HOME_BROWSERS,
    HOME_COMPARISONS,
    HOME_CONTRIBUTIONS,
    HOME_FEATURED_STORES,
    HOME_FEATURES,
    HOME_FEATURES_COPY,
    HOME_HERO_COPY,
    HOME_HONEY_COPY,
    HOME_HONEY_PROBLEMS,
    HOME_HONEY_SOLUTIONS,
    HOME_OPEN_SOURCE_COPY,
    HOME_PLATFORMS,
    HOME_SECURITY_FEATURES,
    HOME_STORES_COPY,
    HOME_WORDMARK_ALT,
} from '@/lib/marketing/homeContent'
import {
    PRICING_COPY,
    PRICING_FEATURES,
    PRICING_STATS,
} from '@/lib/marketing/pricingContent'
import { markdownLink, markdownText, type MarkdownPageContent } from './content'

const origin = 'https://grabcaramel.com'

function faqMarkdown(): string {
    return faqItems
        .map(
            item =>
                `### ${markdownText(item.question)}\n\n${markdownText(item.answer)}`,
        )
        .join('\n\n')
}

function heading(value: string): string {
    return `## ${markdownText(value)}`
}

function buildHome(): MarkdownPageContent {
    const hero = HOME_HERO_COPY
    return {
        title: `${hero.welcome} ${HOME_WORDMARK_ALT}`,
        summary: `${hero.summaryStart} ${hero.openSource} ${hero.and} ${hero.privacyFirst} ${hero.summaryMain} ${hero.withoutSelling} ${hero.or} ${hero.commissions}.`,
        body: [
            markdownLink(hero.install, `${origin}/apps`),
            heading(HOME_FEATURES_COPY.heading),
            markdownText(HOME_FEATURES_COPY.summary),
            ...HOME_FEATURES.map(feature =>
                [
                    `### ${markdownText(feature.title)}`,
                    markdownText(feature.desc),
                    markdownText(feature.detail),
                ].join('\n\n'),
            ),
            heading(HOME_FEATURES_COPY.comparisonHeading),
            markdownText(HOME_FEATURES_COPY.comparisonSummary),
            ...HOME_COMPARISONS.map(item =>
                [
                    `### ${markdownText(item.title)}`,
                    `- ${markdownText(HOME_FEATURES_COPY.otherHeading)}: ${markdownText(item.other)}`,
                    `- ${markdownText(HOME_FEATURES_COPY.caramelHeading)}: ${markdownText(item.caramel)}`,
                ].join('\n'),
            ),
            heading(HOME_FEATURES_COPY.browsersHeading),
            markdownText(HOME_FEATURES_COPY.browsersSummary),
            HOME_BROWSERS.map(browser =>
                markdownLink(browser.name, browser.href),
            ).join('\n\n'),
            heading(HOME_STORES_COPY.heading),
            markdownText(HOME_STORES_COPY.summary),
            HOME_FEATURED_STORES.map(
                store =>
                    `- ${markdownLink(store.name, `${origin}/coupons/${store.domain}`)}: ${markdownText(store.desc)}`,
            ).join('\n'),
            heading(HOME_STORES_COPY.requestHeading),
            markdownText(HOME_STORES_COPY.requestSummary),
            heading(HOME_HONEY_COPY.heading),
            heading(HOME_HONEY_COPY.comparisonHeading),
            markdownText(HOME_HONEY_COPY.comparisonSummary),
            ...HOME_HONEY_PROBLEMS.flatMap((problem, index) => {
                const solution = HOME_HONEY_SOLUTIONS[index]
                return [
                    `### ${markdownText(problem.title)}`,
                    markdownText(problem.desc),
                    `### ${markdownText(solution.title)}`,
                    markdownText(solution.desc),
                ]
            }),
            heading(HOME_HONEY_COPY.switchHeading),
            markdownText(HOME_HONEY_COPY.switchSummary),
            heading(HOME_OPEN_SOURCE_COPY.heading),
            markdownText(HOME_OPEN_SOURCE_COPY.summary),
            heading(HOME_OPEN_SOURCE_COPY.securityHeading),
            HOME_SECURITY_FEATURES.map(
                feature =>
                    `- ${markdownText(feature.title)}: ${markdownText(feature.desc)}`,
            ).join('\n'),
            heading(HOME_OPEN_SOURCE_COPY.communityHeading),
            HOME_PLATFORMS.map(
                platform =>
                    `- ${markdownLink(platform.name, platform.href)}: ${markdownText(platform.desc)}`,
            ).join('\n'),
            heading(HOME_OPEN_SOURCE_COPY.contributionHeading),
            HOME_CONTRIBUTIONS.map(
                contribution =>
                    `- ${markdownLink(contribution.title, contribution.href)}: ${markdownText(contribution.desc)}`,
            ).join('\n'),
            heading(HOME_OPEN_SOURCE_COPY.actionHeading),
            markdownText(HOME_OPEN_SOURCE_COPY.actionSummary),
            heading(FAQ_COPY.heading),
            markdownText(FAQ_COPY.summary),
            faqMarkdown(),
        ].join('\n\n'),
    }
}

function buildPricing(): MarkdownPageContent {
    return {
        title: `${PRICING_COPY.headingPrefix} ${PRICING_COPY.headingEmphasis}`,
        summary: PRICING_COPY.summary,
        body: [
            PRICING_STATS.map(
                stat =>
                    `- ${markdownText(stat.title)} ${markdownText(stat.desc)}`,
            ).join('\n'),
            heading(PRICING_COPY.planHeading),
            markdownText(PRICING_COPY.planSummary),
            PRICING_FEATURES.map(feature => `- ${markdownText(feature)}`).join(
                '\n',
            ),
            markdownLink(PRICING_COPY.cta, GITHUB_REPO_URL),
            heading(PRICING_COPY.whyHeading),
            ...[
                [PRICING_COPY.transparencyHeading, PRICING_COPY.transparency],
                [PRICING_COPY.openSourceHeading, PRICING_COPY.openSource],
                [PRICING_COPY.privacyHeading, PRICING_COPY.privacy],
            ].map(
                ([title, text]) =>
                    `${markdownText(title)} ${markdownText(text)}`,
            ),
        ].join('\n\n'),
    }
}

function buildFaq(): MarkdownPageContent {
    return {
        title: FAQ_COPY.heading,
        summary: FAQ_COPY.summary,
        body: faqMarkdown(),
    }
}

// Pages with inline JSX that has not been extracted remain deliberately absent:
// a twin may only advertise copy consumed by the corresponding HTML page.
export const staticPageBuilders: Readonly<
    Record<'/' | '/pricing' | '/faq', () => MarkdownPageContent>
> = {
    '/': buildHome,
    '/pricing': buildPricing,
    '/faq': buildFaq,
}
