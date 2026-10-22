import { attachSignals } from '@/lib/couponSignals'
import { listCoupons, listTopSites } from '@/lib/couponsRepo'
import {
    COMPARED_EXTENSIONS,
    COMPARISON_CHECKED_ON,
    COMPARISON_FAQ,
    COMPARISON_PATH,
    COMPARISON_PICKS,
    COMPARISON_SOURCES,
    COMPARISON_SUMMARY,
    HONEY_TIMELINE,
    comparisonSourceOrder,
    formatComparisonDate,
    type ComparisonSourceId,
} from '@/lib/seo/extensionComparison'
import {
    COMPARISON_BODY,
    COUPONS_BODY,
    DIRECTORY_BODY,
    GUIDE_BODY,
    HONEY_GUIDE_BODY,
    storeDirectorySummary,
} from '@/lib/seo/guidePageCopy'
import {
    CARAMEL_ROW,
    HONEY_GUIDE_FAQ,
    HONEY_GUIDE_PATH,
    HONEY_GUIDE_SUMMARY,
    HONEY_GUIDE_SUMMARY_SOURCES,
    HONEY_ROW,
    HONEY_VS_CARAMEL,
    honeyGuideSourceOrder,
} from '@/lib/seo/honeyExtensionGuide'
import {
    bucketStoresByLetter,
    directoryLetterLabel,
    directoryPath,
    type DirectoryBucket,
} from '@/lib/seo/storeDirectory'
import { getStoreDirectoryEntries } from '@/lib/seo/storeDirectoryCache'
import {
    couponMarkdown,
    markdownLink,
    markdownText,
    type MarkdownPageContent,
} from './content'

const origin = 'https://grabcaramel.com'

function sourceRefs(
    ids: ReadonlyArray<ComparisonSourceId>,
    order: ReadonlyArray<ComparisonSourceId>,
): string {
    return ids
        .map(id => {
            const index = order.indexOf(id)
            if (index === -1) {
                throw new Error(`Markdown guide: source ${id} has no number`)
            }
            return markdownLink(String(index + 1), COMPARISON_SOURCES[id].url)
        })
        .join(' ')
}

function sources(order: ReadonlyArray<ComparisonSourceId>): string {
    return [
        `## ${GUIDE_BODY.sourcesHeading}`,
        order
            .map((id, index) => {
                const source = COMPARISON_SOURCES[id]
                return `${index + 1}. ${markdownLink(source.title, source.url)}, ${markdownText(source.publisher)}`
            })
            .join('\n'),
    ].join('\n\n')
}

function timeline(order: ReadonlyArray<ComparisonSourceId>): string {
    return [
        `## ${GUIDE_BODY.timelineHeading}`,
        ...HONEY_TIMELINE.map(
            event =>
                `- ${formatComparisonDate(new Date(`${event.date}T00:00:00Z`))}: ${markdownText(event.text)} ${sourceRefs(event.sources, order)}`,
        ),
    ].join('\n\n')
}

function buildHoneyGuide(): MarkdownPageContent {
    const order = honeyGuideSourceOrder()
    return {
        title: HONEY_GUIDE_BODY.heading(COMPARISON_CHECKED_ON.getUTCFullYear()),
        summary: HONEY_GUIDE_SUMMARY,
        body: [
            sourceRefs(HONEY_GUIDE_SUMMARY_SOURCES, order),
            markdownText(
                `${GUIDE_BODY.checkedOn} ${formatComparisonDate(COMPARISON_CHECKED_ON)}${HONEY_GUIDE_BODY.sourceNote}`,
            ),
            `## ${HONEY_GUIDE_BODY.tableHeading}`,
            [
                `| | ${HONEY_ROW.name} ${sourceRefs(HONEY_ROW.sources, order)} | ${CARAMEL_ROW.name} ${sourceRefs(CARAMEL_ROW.sources, order)} |`,
                '| --- | --- | --- |',
                ...HONEY_VS_CARAMEL.map(
                    row =>
                        `| ${markdownText(row.label)} | ${markdownText(row.honey)} | ${markdownText(row.caramel)} |`,
                ),
            ].join('\n'),
            `${markdownLink(HONEY_GUIDE_BODY.installLead, `${origin}/apps`)} ${markdownText(GUIDE_BODY.installBody)}`,
            timeline(order),
            `## ${HONEY_GUIDE_BODY.faqHeading}`,
            ...HONEY_GUIDE_FAQ.map(
                item =>
                    `### ${markdownText(item.question)}\n\n${markdownText(item.answer)}\n\n${GUIDE_BODY.sourcesHeading}: ${sourceRefs(item.sources, order)}`,
            ),
            `${markdownText(HONEY_GUIDE_BODY.onwardBefore)}${markdownLink(HONEY_GUIDE_BODY.homeLink, `${origin}/`)}${markdownText(HONEY_GUIDE_BODY.onwardBetween)}${markdownLink(HONEY_GUIDE_BODY.comparisonLink, `${origin}${COMPARISON_PATH}`)}${markdownText(HONEY_GUIDE_BODY.onwardAfter)}`,
            sources(order),
        ].join('\n\n'),
    }
}

function buildComparison(): MarkdownPageContent {
    const order = comparisonSourceOrder()
    return {
        title: COMPARISON_BODY.heading,
        summary: COMPARISON_SUMMARY,
        body: [
            markdownText(
                `${GUIDE_BODY.checkedOn} ${formatComparisonDate(COMPARISON_CHECKED_ON)}${COMPARISON_BODY.sourceNote}`,
            ),
            `## ${COMPARISON_BODY.tableHeading}`,
            ...COMPARED_EXTENSIONS.map(row =>
                [
                    `### ${markdownText(row.name)}`,
                    markdownText(row.maker),
                    ...(
                        [
                            'price',
                            'revenue',
                            'rewards',
                            'account',
                            'browsers',
                            'sourceCode',
                        ] as const
                    ).map(
                        key =>
                            `- ${COMPARISON_BODY.tableLabels[key]}: ${markdownText(row[key])}`,
                    ),
                    `${GUIDE_BODY.sourcesHeading}: ${sourceRefs(row.sources, order)}`,
                ].join('\n\n'),
            ),
            `## ${COMPARISON_BODY.picksHeading}`,
            ...COMPARISON_PICKS.map(
                pick =>
                    `### ${markdownText(pick.need)}\n\n${markdownText(pick.answer)}`,
            ),
            `${markdownLink(COMPARISON_BODY.installLead, `${origin}/apps`)} ${markdownText(GUIDE_BODY.installBody)}`,
            timeline(order),
            `${markdownText(COMPARISON_BODY.honeyBefore)}${markdownLink(COMPARISON_BODY.honeyLink, `${origin}${HONEY_GUIDE_PATH}`)}.`,
            `## ${COMPARISON_BODY.faqHeading}`,
            ...COMPARISON_FAQ.map(
                item =>
                    `### ${markdownText(item.question)}\n\n${markdownText(item.answer)}`,
            ),
            `${markdownText(COMPARISON_BODY.onwardBefore)}${markdownLink(COMPARISON_BODY.faqLink, `${origin}/faq`)}${markdownText(COMPARISON_BODY.onwardBetween)}${markdownLink(COMPARISON_BODY.directoryLink, `${origin}${directoryPath()}`)}.`,
            sources(order),
        ].join('\n\n'),
    }
}

function letterStrip(buckets: ReadonlyArray<DirectoryBucket>): string {
    if (buckets.length === 0) return ''
    return [
        `## ${DIRECTORY_BODY.browseHeading}`,
        ...buckets.map(
            bucket =>
                `- ${markdownLink(directoryLetterLabel(bucket.letter), `${origin}${directoryPath(bucket.letter)}`)}`,
        ),
        `- ${markdownLink(DIRECTORY_BODY.allStores, `${origin}${directoryPath()}`)}`,
    ].join('\n\n')
}

async function buildCouponHub(): Promise<MarkdownPageContent> {
    // Match the HTML's first-page ranking, signal overlay and existing cached
    // directory. Each underlying list is read once, as on /coupons.
    const [{ coupons, total }, topSites, entries] = await Promise.all([
        listCoupons({ limit: COUPONS_BODY.pageSize, skip: 0 }),
        listTopSites(),
        getStoreDirectoryEntries(),
    ])
    const withSignals = await attachSignals(coupons)
    const seen = new Set<string>()
    const visible = withSignals.filter(coupon => {
        if (seen.has(coupon.id)) return false
        seen.add(coupon.id)
        return true
    })
    const popular = topSites.filter(
        (row): row is { site: string; coupon_count: number } =>
            Boolean(row.site),
    )
    return {
        title: COUPONS_BODY.heading,
        summary: COUPONS_BODY.summary,
        body: [
            ...visible.map(couponMarkdown),
            ...(coupons.length === 0
                ? [COUPONS_BODY.emptyHeading, COUPONS_BODY.emptyBody]
                : coupons.length >= total
                  ? [COUPONS_BODY.endHeading, COUPONS_BODY.endBody]
                  : []),
            markdownText(COUPONS_BODY.sidebarDescription),
            `## ${COUPONS_BODY.browserHeading}`,
            markdownText(COUPONS_BODY.browserBody),
            ...COUPONS_BODY.browsers.map(
                browser => `- ${markdownLink(browser.name, browser.href)}`,
            ),
            `## ${markdownText(COUPONS_BODY.supportedHeading)}`,
            markdownText(COUPONS_BODY.supportedBody),
            markdownLink(
                COUPONS_BODY.supportedLink,
                `${origin}/supported-stores`,
            ),
            ...(popular.length > 0
                ? [
                      `## ${COUPONS_BODY.popularHeading}`,
                      ...popular.map(
                          row =>
                              `- ${markdownLink(row.site, `${origin}/coupons/${encodeURIComponent(row.site)}`)} — ${row.coupon_count} ${row.coupon_count === 1 ? 'code' : 'codes'}`,
                      ),
                  ]
                : []),
            letterStrip(bucketStoresByLetter(entries)),
        ]
            .filter(Boolean)
            .join('\n\n'),
    }
}

async function buildStoreDirectory(): Promise<MarkdownPageContent> {
    const entries = await getStoreDirectoryEntries()
    const buckets = bucketStoresByLetter(entries)
    return {
        title: DIRECTORY_BODY.heading,
        summary: storeDirectorySummary(entries.length),
        body: [
            letterStrip(buckets),
            ...(buckets.length > 0
                ? [
                      `## ${DIRECTORY_BODY.lettersHeading}`,
                      ...buckets.map(
                          bucket =>
                              `- ${markdownLink(directoryLetterLabel(bucket.letter), `${origin}${directoryPath(bucket.letter)}`)} — ${bucket.stores.length.toLocaleString('en-US')} ${bucket.stores.length === 1 ? 'store' : 'stores'}`,
                      ),
                  ]
                : []),
        ]
            .filter(Boolean)
            .join('\n\n'),
    }
}

export const guidePageBuilders = {
    '/honey-extension': buildHoneyGuide,
    '/compare/coupon-extensions': buildComparison,
    '/coupons': buildCouponHub,
    '/coupons/stores': buildStoreDirectory,
} satisfies Record<
    string,
    () => MarkdownPageContent | Promise<MarkdownPageContent>
>
