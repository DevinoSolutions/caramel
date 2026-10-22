// One public-path registry for the handler, beforeFiles rewrites and Link
// headers. Plain JS so next.config.mjs can read it without loading app code.
// Inline-only pages are deliberately absent until their body copy is shared.
export const MARKDOWN_TWIN_PATHS = [
    '/',
    '/pricing',
    '/faq',
    '/honey-extension',
    '/compare/coupon-extensions',
    '/coupons',
    '/coupons/stores',
    '/coupons/:store',
]

export const MARKDOWN_ORIGIN = 'https://grabcaramel.com'
export const MARKDOWN_ACCEPT = '(?!.*text/html).*text/markdown.*'

// A registrable store domain contains a dot before the appended suffix. This
// preserves canonical HTML stores on Moldova's .md TLD (for example jysk.md).
const STORE_DOMAIN_PATTERN = '[^/]+\\.[^/]+'
const STATIC_COUPON_PATHS = MARKDOWN_TWIN_PATHS.filter(
    path => path.startsWith('/coupons/') && path !== '/coupons/:store',
).map(path => path.slice('/coupons/'.length))

/** @param {string} htmlPath @returns {string} */
export function markdownPath(htmlPath) {
    return htmlPath === '/' ? '/index.md' : `${htmlPath}.md`
}

/** @param {string} htmlPath @returns {string} */
function handlerPath(htmlPath) {
    return htmlPath === '/' ? '/md/index' : `/md${htmlPath}`
}

/** @returns {{source: string, destination: string, has?: {type: 'header', key: string, value: string}[]}[]} */
export function buildMarkdownRewrites() {
    return MARKDOWN_TWIN_PATHS.flatMap(htmlPath => [
        {
            source:
                htmlPath === '/coupons/:store'
                    ? `/coupons/:store(${STORE_DOMAIN_PATTERN}).md`
                    : markdownPath(htmlPath),
            destination: handlerPath(htmlPath),
        },
        {
            source: htmlPath,
            destination: handlerPath(htmlPath),
            has: [{ type: 'header', key: 'accept', value: MARKDOWN_ACCEPT }],
        },
    ])
}

/** @returns {{source: string, missing: {type: 'header', key: string, value: string}[], headers: {key: string, value: string}[]}[]} */
export function buildMarkdownHeaders() {
    return MARKDOWN_TWIN_PATHS.map(htmlPath => ({
        // Next preserves a configured Link over the route handler's Link.
        // Only HTML may receive the alternate: negotiated documents and store
        // .md URLs must keep the handler's normalized canonical instead.
        source:
            htmlPath === '/coupons/:store'
                ? `/coupons/:store((?!(?:${[STORE_DOMAIN_PATTERN, ...STATIC_COUPON_PATHS].join('|')})\\.md$)[^/]+)`
                : htmlPath,
        missing: [{ type: 'header', key: 'accept', value: MARKDOWN_ACCEPT }],
        headers: [
            {
                key: 'Link',
                value: `<${MARKDOWN_ORIGIN}${markdownPath(htmlPath)}>; rel="alternate"; type="text/markdown"`,
            },
            { key: 'Vary', value: 'Accept' },
        ],
    }))
}
