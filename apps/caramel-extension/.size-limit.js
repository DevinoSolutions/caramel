/* Bundle-size budgets — measured over MINIFIED bytes (re-baselined 2026-08-10).
 *
 * `pnpm size` runs scripts/measure-size.mjs first, which minifies every shipped
 * script into .size-cache/ and is where the file lists live. These paths point
 * at that output, so what gets weighed here is roughly the CODE: comments and
 * formatting are gone before the ruler touches anything. Explaining a fix costs
 * nothing; adding logic costs bytes. That is the whole point of the change.
 *
 * It replaces a raw-source budget that priced prose, and it is worth one line
 * on why: that gate took seven documented raises in four days, several of them
 * buying room for sentences rather than behaviour, and it sent at least one
 * session shaving comments to fit a ceiling whose stated purpose was bounding
 * code that runs on every store page. It also spent a period permanently red,
 * which silently skipped the packaging step that ran after it. A budget nobody
 * can satisfy is not a budget.
 *
 * These are still a RATCHET, same shape as ty_baseline.json in the sibling
 * repo. Growth from here fails the build, so it has to be a decision rather
 * than a drift — and now a raise means real code arrived. Raising a number is
 * allowed; raising it silently is not. Date the reason beside it.
 *
 * The headroom over each measurement is deliberate but small (~10%): a budget
 * sitting a few bytes above the measurement turns the next honest edit into a
 * red build, and one sitting far above it stops being a gate at all.
 *
 * NOTE — this does not bound the DOWNLOAD. The WXT build ships these modules
 * with comments intact, so the shipped package is unminified and a store
 * download really does carry them. That is a once-per-install cost; this gate
 * exists for the per-page-load one. A ceiling on the shipped artifact would be
 * a separate budget over .output/.
 *
 * JS rather than JSON purely so this paragraph can sit next to the numbers it
 * explains; size-limit rejects unknown keys in a JSON config.
 */
module.exports = [
    {
        name: 'content-scripts (injected, minified)',
        path: '.size-cache/content-scripts.min.js',
        // 2026-08-10 — measured 70.68 kB minified, from 268.33 kB of source
        // (73.7% of the old budget was formatting and prose).
        limit: '76 KB',
        brotli: false,
    },
    {
        name: 'popup-core.js (minified)',
        path: '.size-cache/popup.min.js',
        // 2026-08-10 — measured 28.29 kB minified, from 63.39 kB of source.
        // 2026-08-13 (P2), lowered 33 -> 6.5 kB: popup.js became
        // popup-core.js and every render moved to the React popup (its own
        // budget below) — what remains is the pinned logic, measured 5.67 kB.
        // A ratchet locks wins in, not just losses out.
        // 2026-08-14, raised 6.5 -> 9.6 kB: the Safari OAuth poll client came
        // back (tab + nonce flow, the poll loop, the pending-nonce resume —
        // Safari has no launchWebAuthFlow, so this is the only in-popup
        // sign-in it has). Real behaviour, measured 8.71 kB. This is the raise
        // the header sanctions: a whole flow arrived, not prose.
        limit: '9.6 KB',
        brotli: false,
    },
    {
        name: 'popup React views (ours, minified)',
        path: '.size-cache/popup-react.min.js',
        // 2026-08-13 (P2) — measured 27.04 kB minified: the App shell, the six
        // views (coupons w/ paging + star + guest gate, sign-in, settings,
        // profile, unsupported, load-error), toast, banner, and caramel-ui's
        // sources. Vendor react/react-dom are deliberately NOT weighed — see
        // measure-size.mjs — so growth here is always OUR code growing.
        limit: '30 KB',
        brotli: false,
    },
    {
        name: 'background.js (sw, minified)',
        path: '.size-cache/background.min.js',
        // 2026-08-10 — measured 7.04 kB minified, from 21.96 kB of source.
        // 2026-08-10, raised 7.5 -> 7.8 kB: the fetchCoupons branch forwards a
        // page number and passes the route's page/total/hasMore envelope back
        // to the popup (measured 7.3 kB). Raised rather than left at 2.7%
        // headroom, which is close enough to the ceiling to red the next
        // honest edit — see the headroom note above.
        limit: '7.8 KB',
        brotli: false,
    },
]
