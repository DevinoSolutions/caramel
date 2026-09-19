/**
 * IndexNow key for grabcaramel.com.
 *
 * IndexNow (https://www.indexnow.org) is the open ping protocol shared by
 * Bing, Yandex, Seznam and Naver: one POST to api.indexnow.org tells all of
 * them that a URL changed, instead of waiting for the next organic crawl.
 * That is the legitimate push channel for the 4,000+ per-store coupon pages
 * (/coupons/<store>) that the engines are slow to discover on their own.
 *
 * WHY the key is committed in plain sight: the protocol authenticates a
 * submission by requiring the SAME key to be readable at
 * `https://<host>/<key>.txt`. The key is therefore public BY DESIGN — it is
 * served verbatim to anyone who asks — and putting it in the env layer would
 * buy no secrecy. It is a host-ownership proof, not a credential: the only
 * thing holding it lets anyone do is ask a search engine to re-crawl a URL
 * that is already on our own public site.
 *
 * WHY a route handler instead of `public/<key>.txt`: this keeps the key a
 * single typed constant with compile-time consumers, so rotating it is one
 * edit that the CI pin (tests/unit/indexnow-key-file.test.ts) re-checks,
 * rather than a filename and a file body that can silently disagree.
 *
 * Submission is NOT done from the app. The SEO owner submits URL changes
 * through the fleet seo-mcp (`indexing_submit method=index_now`); this
 * module only serves the ownership proof.
 *
 * Env-free and alias-free on purpose: the e2e spec imports it relatively
 * (Playwright does not resolve the `@/` tsconfig alias for spec files).
 *
 * To rotate: change the value here AND rename src/app/<key>.txt to match,
 * then re-run the unit pin.
 */
export const INDEXNOW_KEY = 'd5c0ad54cc4dc724a423fa3e9d273f7f'

/** Path IndexNow fetches to verify host ownership: `/<key>.txt`. */
export const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`

/**
 * The verification file's body is the key and nothing else — no trailing
 * newline, because validators compare the fetched body to the key after at
 * most a trim, and an exact match is the only form that is safe everywhere.
 */
export function indexNowKeyResponse(): Response {
    return new Response(INDEXNOW_KEY, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            // The value only changes on deploy, and IndexNow re-fetches it
            // on every submission, so a day at the edge is safe.
            'Cache-Control': 'public, max-age=86400',
        },
    })
}
