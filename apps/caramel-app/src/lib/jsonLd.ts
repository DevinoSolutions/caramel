// Serialize structured data for a `<script type="application/ld+json">` tag.
// `<` is escaped as its 6-char JSON unicode escape (identical parse result)
// so a catalog-sourced string containing `</script>` can never terminate the
// element early and inject markup — use this, never raw JSON.stringify, when
// the payload includes any non-literal string (coupon titles, descriptions).
export function jsonLdString(data: unknown): string {
    return JSON.stringify(data).replace(/</g, '\\u003c')
}

export type FaqPageJsonLd = {
    '@context': 'https://schema.org'
    '@type': 'FAQPage'
    mainEntity: Array<{
        '@type': 'Question'
        name: string
        acceptedAnswer: { '@type': 'Answer'; text: string }
    }>
}

/** FAQPage JSON-LD for questions a page ALSO renders visibly: Google only
 *  honours FAQ markup that matches the page's own text, so build both from
 *  the same list. */
export function faqPageJsonLd(
    items: ReadonlyArray<{ question: string; answer: string }>,
): FaqPageJsonLd {
    return {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: items.map(item => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: { '@type': 'Answer', text: item.answer },
        })),
    }
}
