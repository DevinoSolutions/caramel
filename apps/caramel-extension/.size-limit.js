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
        // 2026-10-06, raised 76 -> 80 kB: checkout code sharing became opt-in
        // (owner rule 2026-10-06) — the consent card (UI-helpers.js
        // showCodeSharingPrompt) and the consent record module
        // (code-sharing-consent.js). Measured 76.66 kB: one new UI surface.
        // 2026-10-13, raised 80 -> 117 kB: coupon-box-discovery.js, the
        // promo-box finder for stores with no usable config (off behind a
        // server flag). 91.74 → 107.8 kB: the finder itself (nine-language
        // vocabularies, field/button/toggle scoring, the total-row reader) was
        // 91.74 kB at its first push; the rest is hardening against live
        // stores and review fixes (re-find after a re-draw, hidden label
        // cells, the coupon-line reader, the finder-run verdict gate, and the
        // lookbehind-free text readers Safari 16.0-16.3 needs). Same date, the
        // finder's server pick (own flag, couponBoxLlm): the asking and the
        // checking of the answer live here, 107.8 -> 111.27 kB; the outline
        // builder is NOT in this bundle, it ships as assets/coupon-box-outline.js
        // and has its own budget below. 4.9% headroom over 111.27 kB, so the
        // next capability trips the ratchet.
        // 2026-10-15, raised 117 -> 120 kB: install attribution
        // (install-attribution.js plus the /welcome first-touch capture in
        // coupon-runner.js) — the cookie reader pinned to the website's
        // schema, the install-id/record storage and the bounded retry.
        // Measured 111.27 -> 114.55 kB (+3.3 kB): one new capability, not prose.
        // 2026-10-16, raised 120 -> 122 kB: the finder's safety guards (it
        // never clicks a points, rewards, offers or settings control, judged
        // by the control's words, its neighbours and its section's name) and
        // the store lookup's registrable-domain check for hyphen hosts.
        // Measured 118.05 -> 120.89 kB; 121.47 kB once the finder also never
        // clicks a control that adds to the cart, buys, adds a gift extra,
        // updates the cart, subscribes or signs in (noCodeClick, the same
        // words the server-pick checks use).
        // 2026-10-17, raised 122 -> 122.5 kB: an apply button with no apply
        // word on it is taken only in the box's own panel, and never when its
        // attributes say remove, quantity, checkout, pay, buy, sign in or up,
        // subscribe or wishlist (wordlessApply). Measured 122.01 kB. The
        // finder is ~28.5 kB of this bundle on every page; loading it on
        // demand (coupon-box-finder.js) takes it out and brings this bundle
        // back down to about 93.7 kB.
        // 2026-10-17, raised 122.5 -> 123 kB: the finder never spends store
        // credit, a gift card or a balance, reads every page in bounded time,
        // and never clicks "Next", "Proceed" or an orders link on the
        // server's word (the server's never-click list, byte for byte).
        // Measured 122.58 kB.
        // 2026-10-17, raised 123 -> 125 kB: stacked on the per-tab pick
        // memory (a cart that reloads to show each answer keeps the server's
        // box, found again by name). Measured 124.35 kB.
        // 2026-10-17, lowered 125 -> 95.5 kB: the finder left this bundle. It
        // ships as assets/coupon-box-finder.js (its own budget below) and is
        // loaded only by a page that runs it; what stays is the flag read and
        // the loader (coupon-box-finder-loader.js). Measured 124.35 -> 94.22
        // kB (93.68 before the per-tab pick memory, 93.55 before the loader
        // learned to report a failed load and to refuse a module without the
        // hand-over), so the limit is measured + ~1.3 kB.
        // The server-pick branch, measured against the 120 kB bundle that still
        // held the finder:
        // 2026-10-16, raised 120 -> 122 kB: the server's pick mode
        // (rules_first / llm_first / llm_only, and the prompt asking the same
        // question per mode) and the remembered coupon box (read it first,
        // check it like any pick, carry it across a reload, hand its outcome
        // to the module that saves it). Measured 113.05 -> 116.66 kB at first
        // push, 121.36 kB after the review fixes (the learned-apply gate, the
        // leave-the-page rule on every path, the setting and section rules);
        // naming a box ships on demand (coupon-box-learned.js, below), not
        // here.
        // 2026-10-17, raised 122 -> 125 kB: a submit that leaves the store
        // (formaction/form target) is never the apply, a positional or
        // whole-form wordless apply is refused, and the remembered box is
        // asked of the background instead of read from page storage.
        // Measured 122.14 kB; 122.4 kB once the finder's pick memory moved to
        // the background too (the per-tab handoffs).
        // 2026-10-17, raised 125 -> 130 kB: this branch merged main through
        // #348, which brings in the notes above it dated 2026-10-15 (install
        // attribution, the porkbun capability marker) and the handoff store's
        // review fixes. Measured 128.46 kB.
        // 2026-10-19, raised 95.5 -> 97 kB: the server pick mode and the
        // remembered coupon box joined the on-demand finder. Their content
        // script share (the mode read, the learned-box handoff, the resumed
        // learn) stays in this bundle; the finder itself ships on demand.
        // Measured 96.05 kB.
        limit: '97 KB',
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
        // 2026-08-19, raised 9.6 -> 11 kB: permission-state.js joined this
        // group (it is popup-realm logic — see the GROUPS note in
        // measure-size.mjs). It is the missing-host-permission machinery: the
        // promise/callback bridge over the two permissions APIs, the
        // every-website match pattern per runtime, the reachability probe that
        // tells "the browser refused us" apart from "you are offline", and the
        // gesture-safe request. Measured 10.04 kB.
        // 2026-10-15: the sign-in sends the install's attribution (the exchange
        // body fields, the Safari authorize query and the unreadable-storage
        // report). Measured 10.81 kB, still under the unchanged 11 kB budget.
        limit: '11 KB',
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
        // 2026-08-19, raised 30 -> 33.5 kB: a seventh view (PermissionView,
        // the browser-refused-us state that used to render as a connection
        // error) plus the AllSitesBanner component for the narrow-grant
        // install. Measured 30.39 kB — two real surfaces, not prose.
        // 2026-10-11, raised 33.5 -> 41 kB (issue #288): the popup's "Did it
        // work?" vote prompt, per-shopper hide, and the two collapsed
        // sections (reported-not-working, hidden) — three new components plus
        // the storage module behind them (couponVote.ts). Measured 31.33 ->
        // 37.97 kB (+6.64 kB): one new feature surface, not prose.
        // 2026-10-17, raised 41 -> 42 kB: Safari's own menu route for the
        // every-website grant became a shared component (SafariAllSitesSteps)
        // that the banner now shows too, because Safari's permissions.request()
        // resolves without granting and left the banner's Enable button dead.
        // Main already sat ~0.1 kB under 41 kB; this measured 41.04 kB.
        limit: '42 KB',
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
        // 2026-10-02, raised 7.8 -> 9.2 kB: the submitShopperCode handler for
        // shopper code capture — the sign-in + server-flag gate, the 6h
        // features cache (storage.session, memory fallback) and the mapping of
        // the submit route's answers onto skipped-vs-error. Measured 8.4 kB
        // (was 6.41 kB): one new message route, not prose.
        // 2026-10-06, raised 9.2 -> 10 kB: submitShopperCode also reads the
        // checkoutCodeSharingConsent record (code-sharing-consent.js) and
        // answers no-consent, so nothing is sent before an explicit yes.
        // Measured 9.29 kB.
        // 2026-10-09, raised 10 -> 10.7 kB: the features cache now carries the
        // couponBoxDiscovery flag too, answered to the content script on its
        // own message route. Measured 9.85 kB (re-measured 2026-10-13; first
        // recorded as 9.67); raised rather than left at 1.5%
        // headroom (see the 2026-08-10 note above).
        // 2026-10-13, raised 10.7 -> 11.3 kB: the coupon-box pick request (its
        // flag, its message route, and one deadline over the flag read, the
        // token read and the request). Measured 10.52 kB.
        // 2026-10-15, raised 11.3 -> 13.4 kB: the opt-in code-sharing funnel
        // diagnostics (1.4.14): reportCodeShareFunnel, the consent + telemetry
        // id module (usage-diagnostics-consent.js), the payload allowlist
        // (code-share-funnel.js) and the shared permissions wrapper
        // (permissions-api.js) for the Firefox data-collection grant. Measured
        // 12.24 kB.
        // 2026-10-15 (review of PR #353), tightened 13.4 -> 12.7 kB: the 2 kB of
        // slack the first raise left would have let the next unrelated growth
        // through unnoticed. Measured 12.38 kB after the review fixes (id minted
        // only on accept, the consent re-read, device-local consent), so the
        // limit is measured + ~0.3 kB.
        // 2026-10-17, raised 12.7 -> 13.6 kB: the per-tab handoffs
        // (tab-handoff.js and its message route), which hold the pending
        // submit, the discount-link win and the run where the store's page
        // cannot write them. Measured 13.24 kB.
        // 2026-10-17 (review of PR #369), raised 13.6 -> 13.9 kB: the handoff
        // route answers only the tab's top, live document, forgets a tab the
        // browser replaces, writes down a refused record, and gains the
        // compare-and-set replace that makes a cancel one step. Measured
        // 13.60 kB.
        // On this branch, before it merged main through #348:
        // 2026-10-16, raised 11.3 -> 12.7 kB: the pick mode beside the flag,
        // the couponBoxLearned flag, and behind it the learned-answer opt-in
        // and the learned coupon box report (install id read, the POST, what
        // the server recorded). Measured 10.68 -> 11.77 kB.
        // 2026-10-17, raised 12.7 -> 15 kB: the learned-box memory moved here
        // from the page (a page can write its own storage): the background
        // reads and writes it for the sender tab's own host through
        // coupon-box-learned.js (validation and the selector grammar), holds
        // the box a run used across a reload per tab, and serialises writes
        // across tabs. Measured 13.57 kB.
        // 2026-10-17, unchanged at 15 kB: the per-tab handoff store
        // (tab-handoff.js) joined, and the box a run holds across a reload
        // moved onto it in place of its own copy. Measured 13.97 kB.
        // 2026-10-17, raised 15 -> 16.6 kB: main through #348 brings the
        // code-sharing funnel diagnostics (dated 2026-10-15 above) and the
        // handoff store's review fixes. Measured 16.2 kB.
        limit: '16.6 KB',
        brotli: false,
    },
    {
        name: 'coupon-box-outline.js (loaded on demand, minified)',
        path: '.size-cache/coupon-box-outline.min.js',
        // 2026-10-13 — measured 8.30 kB minified. Not injected on every page:
        // the finder imports it only when it is about to ask the server for a
        // box. About half of it is the word allowlist every name is filtered
        // through, which is data the server's eval was measured with.
        limit: '9.2 KB',
        brotli: false,
    },
    {
        name: 'coupon-box-finder.js (loaded on demand, minified)',
        path: '.size-cache/coupon-box-finder.min.js',
        // 2026-10-17 — measured 29.74 kB, built exactly as it ships
        // (scripts/finder-bundle.mjs). Not injected on every page: the
        // content script imports it only when the finder flag is on and the
        // page has no box a config describes. The nine-language vocabularies
        // and the field, button, toggle and total-row readers are most of it
        // (28.06 kB before it learned never to click a control that is not a
        // code, 28.64 kB before an apply button with no apply word was
        // limited to the box's own panel, 29.18 kB before it refused store
        // credit, gift cards and balances and bounded what each rule reads,
        // 29.65 kB before it refused the server's whole never-click list).
        // The limit is measured + ~0.75 kB.
        // 2026-10-17, raised 30.5 -> 32 kB: the per-tab pick memory (a cart
        // that reloads to show each answer keeps the server's box, found again
        // by name) ships in the finder. Measured 30.98 kB.
        // 2026-10-19, raised 32 -> 37.5 kB: the server pick mode, the
        // remembered coupon box and the checks on a learned apply ship in the
        // finder now that it loads on demand. Measured 36.68 kB.
        // It is written only here: tests/finder-module-build.test.mjs reads
        // it.
        limit: '37.5 KB',
        brotli: false,
    },
    {
        name: 'porkbun-alert-shim.js (porkbun.com checkout only, minified)',
        path: '.size-cache/porkbun-alert.min.js',
        // 2026-10-15 (T-2480) — own MAIN-world content script for porkbun.com's
        // native coupon-failure alert(). 2026-10-16: the page-world capability
        // marker (extension-capabilities.js, bundled into it) took it from 1.18
        // to 1.86 kB minified; the same module adds ~0.8 kB to the per-page
        // content-scripts group above (116.69 -> 117.49 kB, inside its limit).
        limit: '2 KB',
        brotli: false,
    },
    {
        name: 'coupon-box-learned.js (loaded on demand, minified)',
        path: '.size-cache/coupon-box-learned.min.js',
        // 2026-10-16 — measured 3.55 kB minified. Not injected on every page:
        // the finder imports it only on a store with no config, to name a box
        // it may remember (stable selectors) and to save and report what a
        // run on that box showed (the per-install memory, LRU 200 domains).
        // Same date, raised 3.8 -> 4.5 kB: the selector grammar every learned
        // selector is built in and read through (a served or stored selector
        // outside it is never queried), and the one-element lookup the finder
        // reads a learned box with. Measured 3.55 -> 4.19 kB.
        // 2026-10-17, raised 4.5 -> 4.8 kB: the server's two refusals,
        // mirrored so a box it would refuse is never remembered nor sent (no
        // personal-data shapes in any selector; no apply or toggle that names
        // checkout, ordering, paying or removing). Measured 4.43 kB.
        // 2026-10-17, raised 4.8 -> 5.1 kB: the server's final rules for
        // both (long numbers only in attribute values other than id, even
        // split by spaces, dashes or dots; risky words only in the clicked
        // element, as whole words or pairs). Measured 4.88 kB.
        // 2026-10-17, raised 5.1 -> 5.4 kB: `checkout` is not risky when the
        // clicked element also names a coupon word (the cart's own coupon
        // apply). Measured 5.11 kB.
        limit: '5.4 KB',
        brotli: false,
    },
]
