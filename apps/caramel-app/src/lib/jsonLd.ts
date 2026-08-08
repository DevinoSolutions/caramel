// Serialize structured data for a `<script type="application/ld+json">` tag.
// `<` is escaped as its 6-char JSON unicode escape (identical parse result)
// so a catalog-sourced string containing `</script>` can never terminate the
// element early and inject markup — use this, never raw JSON.stringify, when
// the payload includes any non-literal string (coupon titles, descriptions).
export function jsonLdString(data: unknown): string {
    return JSON.stringify(data).replace(/</g, '\\u003c')
}
