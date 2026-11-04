// lib/couponPlainText.ts
//
// A catalog title or description as plain text.
//
// The supplier's scrapers store some of them HTML-escaped. Live catalog,
// 2026-10-29: 1,694 descriptions and 1,386 titles carry an entity, mostly
// `&amp;` (2,050) and `&#039;` (1,098), a few `&lt;br&gt;`, and 49 rows are
// escaped twice (`&amp;#039;`). Every surface renders these fields as text
// (React, the extension's textContent), so a shopper read "Save $10 off books,
// music &amp; video games" on the store page and "Prices are shown with
// discounts applied.&lt;br&gt; &lt;br&gt; *Free Pro-Grade Bypass Kit" on the
// extension's final card (aquasana.com, 1.4.26 store build).
//
// Decoding is safe for every consumer: React and the extension never render
// these fields as HTML, and JSON-LD goes through jsonLdString, which escapes
// `<`. The catalog row itself is not rewritten: the supplier owns it
// (DESIGN.md §2 "Write-ownership").

const NAMED: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
}

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi

// A line or paragraph break that was escaped into the text: it read as a gap,
// so it becomes a space.
const BREAK_TAG = /<\s*\/?\s*(br|p)\s*\/?\s*>/gi
// Inline formatting that was escaped into the text: its words stay, the tag
// goes. Any other `<` (e.g. "<<COUPONS UPDATE TODAY>>") is left as written.
const FORMAT_TAG = /<\s*\/?\s*(b|strong|i|em|u|span|small)\s*>/gi

function decodeOnce(text: string): string {
    return text.replace(ENTITY, (whole, body: string) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X'
            const point = Number.parseInt(
                body.slice(hex ? 2 : 1),
                hex ? 16 : 10,
            )
            // Outside Unicode or a control character: leave the entity as it
            // was rather than print a replacement glyph.
            if (!Number.isInteger(point) || point < 32 || point > 0x10ffff)
                return whole
            return String.fromCodePoint(point)
        }
        return NAMED[body.toLowerCase()] ?? whole
    })
}

/** `text` with HTML entities decoded (twice at most, for the doubly escaped
 *  rows), escaped line breaks turned into spaces and escaped inline
 *  formatting tags dropped. */
export function couponPlainText(text: string): string {
    if (!text.includes('&') && !text.includes('<')) return text
    const once = decodeOnce(text)
    const decoded = once === text ? once : decodeOnce(once)
    return decoded
        .replace(BREAK_TAG, ' ')
        .replace(FORMAT_TAG, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
}
