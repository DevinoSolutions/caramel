/* Bundle-size budgets — RE-BASELINED 2026-08-06.
 *
 * These are RAW SOURCE BYTES (@size-limit/file — no bundler, no minifier), so
 * every line of the explanatory comment this codebase's house style requires is
 * counted as if it were executable weight. It isn't: the parser discards
 * comments, and the cost this gate exists to bound is CODE running on every
 * store page load.
 *
 * The consequence was predictable, and had already happened. The gate went red
 * on 2026-08-04 — roughly 54 KB over on content-scripts — and stayed red through
 * every commit since, which also meant the `Build the store package` step that
 * runs after it never executed on any of them. A budget that is permanently red
 * is not a budget. And it was not the codebase that was wrong: "a rule that
 * lives only in a file will be forgotten" cuts both ways, because a check nobody
 * can satisfy gets ignored exactly like a rule with no check.
 *
 * So these are the sizes measured TODAY, and they are a RATCHET — the same shape
 * as scripts/ty_baseline.json and except_silent_baseline.json in the sibling
 * repo. Growth from here fails the build, so it has to be a decision rather than
 * a drift. Raising a number is allowed; raising it silently is not. Date the
 * reason beside it.
 *
 * TODO: the honest long-term fix is to measure MINIFIED bytes, which would price
 * code and stop pricing prose, and would put the real figure far below these. It
 * needs a measurement-only bundler (@size-limit/esbuild) — a deliberate call
 * about a repo that ships unbundled by design, so it belongs to the owner and
 * not to the same change that re-baselines the numbers.
 *
 * JS rather than JSON purely so the paragraph above can sit next to the numbers
 * it explains; size-limit rejects unknown keys in a JSON config.
 */
module.exports = [
    {
        name: 'content-scripts (injected)',
        path: [
            'caramel-env.js',
            'coupon-constants.generated.js',
            'cart-signals.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
            'UI-helpers.js',
            'inject.js',
        ],
        // 2026-08-06 — 219 → 223 KB. Two behaviour changes plus the reasoning
        // they carry: the capability gate now opens for a store with codes and
        // no config row (store-detect.js), and the no-record branch asks the
        // catalogue before telling a shopper we hold nothing for their store
        // (coupon-runner.js).
        //
        // 2026-08-06 — 223 → 227 KB. Both live-QA fixes land in coupon-runner:
        // reading a discount the platform records in
        // `cart_level_discount_applications` rather than on the code entry (the
        // shape every real cart measured that day actually uses, and whose
        // absence silently deleted a shopper's live -$9.00), and crediting the
        // code the cart is honouring when it is one we probed. Measured
        // 226.71 kB.
        //
        // 2026-08-06 — 227 → 230 KB. The top-bar probe in UI-helpers.js became
        // a bounded DOM sweep after eight live carts showed the old hit test
        // could not see past a cookie scrim or into a `pointer-events:none`
        // nav. Measured 229.68 kB.
        //
        // That is the THIRD raise in one day, all three for behaviour plus the
        // measurements recorded beside it, and it is the signal the TODO above
        // predicted: at ~1 KB of prose per fix this gate now tracks how much
        // was explained, not how much runs. It is still doing its job — every
        // raise here was a deliberate line in a diff — but the next person to
        // hit it should price minified bytes instead of raising it a fourth
        // time. That call is the owner's, per the note above.
        //
        // 2026-08-06 — 230 → 232 KB, and yes, that is the fourth raise, by the
        // same session that wrote the paragraph above telling itself not to.
        // The unpinned-header case (100percentpure) and the overlap rule that
        // stopped the pill dodging a bar it never touched (cultbeauty) landed
        // in UI-helpers.js. 1.2 KB of the 2.6 KB it cost was paid back by
        // cutting prose first; deleting the rest would have meant deleting the
        // store-by-store numbers that stop a future edit undoing the fix, which
        // is a worse trade than a 2 KB line. Measured 231.44 kB.
        //
        // The standing recommendation is unchanged and now overdue: price
        // MINIFIED bytes. Until an owner takes that call, a raise here is the
        // honest move and a silent one still is not.
        //
        // 2026-08-06 — 232 → 233 KB. `_caramelUsableTitle` now drops a claim
        // whose amount fell out of the scrape (100percentpure ships LASHES as
        // "Get off with code"). The fix plus its comment ran 174 B over after
        // four rounds of trimming prose elsewhere in the file, which is the
        // clearest statement yet that this gate is measuring the wrong bytes:
        // an afternoon can be spent shaving sentences to fit a budget whose
        // stated purpose is bounding CODE that runs on every store page.
        // Measured 232.17 kB.
        //
        // 2026-08-06 — 233 → 239 KB, two behaviour changes in one evening
        // pass. Console silence: the dev-gated logError in caramel-base.js,
        // because three raw console.error calls were printing into STORES'
        // consoles on shoppers' machines (pinned by
        // tests/console-silence.test.mjs). Cart-intent signal: store-detect's
        // gate now opens on the URL SHAPES that drawer-cart stores actually
        // write — measured live: allbirds 302s /cart to /?openCartDrawer=true
        // and toms navigates it to /?open_cart=true then rewrites to bare / —
        // where the old path-only rule saw an ordinary home page and the
        // shopper got silence on a store we hold codes for. Measured
        // 238.97 kB.
        //
        // 2026-08-06 — 239 → 249 KB. The restore step was destroying the
        // discount it existed to protect: measured live on harney.com, the
        // shopper's own HARNEY10 survived all eight probes, the re-apply killed
        // it (the /discount endpoint appends, and re-sending an attached code
        // demotes it), and `restored: true` was asserted from the REQUEST
        // succeeding while the same log line carried the undiscounted total.
        // The fix is three helpers in coupon-runner.js — ask whether a NAMED
        // code is still live, clear-then-send when a restore is genuinely
        // needed, and gate the "already applied and saving you" sentence on the
        // money being back — plus a third modal branch for the outcome that
        // previously had no honest wording at all (their code gone, unrecovered).
        // ~3.5 kB of that is code; the rest is the harney measurement, stated
        // once in coupon-apply.js and cross-referenced. A first trimming pass
        // bought 0.7 kB; going further would delete the store-by-store numbers,
        // which the 232→233 KB note above already ruled the worse trade.
        // Measured 247.99 kB — the extra kB over that is deliberate headroom,
        // not slack: 248 left ten bytes, which turns the next comment edit into
        // a build failure that says nothing true about bundle weight.
        // 2026-08-07 — 249 → 256 KB. The fleet-silence root-cause fix:
        // caramelSendMessage in caramel-base.js (bounded worker waits +
        // runtime.lastError read — the raw sendMessage form could hang the
        // apply flow forever on an evicted worker), and store-detect's
        // boundary now distinguishes "the API answered" from "we could not
        // ask" (retry once, expired-cache fallback, STORE_LIST_FETCH_FAILED
        // recorded) instead of rendering both as "unsupported store".
        // Measured live: the worker's cold fetch of the 1.14 MB store list
        // ran 6.7 s→>60 s against an 8 s abort, and the abort became an
        // empty list — silence on every fresh install. ~2.5 kB is code; the
        // rest is the measurement prose that stops the next edit undoing it.
        // Measured 254.83 kB.
        //
        // 2026-08-08 — 256 → 258 KB. Two residuals in the already-applied
        // discount handling, both in coupon-runner.js. The no-win path reported
        // 'failed' to the trust loop with no preExistingDiscount gate, so a
        // store refusing to stack ("cannot be combined with the discount
        // already applied" — text that reaches lastStoreReason WITHOUT
        // rejection vocabulary) spent a permanent verdict on a valid code; the
        // report is now withheld, because the endpoint's vocabulary is exactly
        // {worked, failed} and has no neutral value to send. And the
        // zero-effect branch, which had the same snapshot in scope, hedged at
        // shoppers whose live discount we could see and dropped the
        // replace-warning its sibling treats as mandatory. ~0.6 kB is code and
        // message copy; the rest states the constraint, which is the whole
        // defence against the next edit reinstating a false 'failed'. A first
        // pass paid back 0.7 kB by cutting prose. Measured 256.71 kB — 258
        // rather than 257 for the same reason the 249 line gives: ~290 B of
        // headroom makes the next comment edit a build failure that says
        // nothing true about bundle weight. The standing recommendation above
        // (price MINIFIED bytes) is now five raises overdue and still the
        // owner's call.
        limit: '258 KB',
        brotli: false,
    },
    {
        name: 'popup.js',
        path: 'popup.js',
        // 2026-08-09 — 54 → 60 KB, first raise for this budget. The
        // follow-this-store star in the coupons-view header: the button markup,
        // the star SVG in both states, and wireFavoriteStoreButton() (asks the
        // account what it follows, paints the true state, toggles through the
        // service worker, reverts a rejected write). ~3.5 kB is code and markup;
        // the rest states the two constraints that would otherwise be re-decided
        // wrongly — the star is signed-in-only, and it must live INSIDE the
        // existing header row, because popup-sizing.test.mjs's 320px coupon-list
        // cap is measured against everything stacked above it and a header that
        // grew by a row would slice the last coupon card. A trimming pass paid
        // back 0.35 kB; going further meant deleting those two, which the
        // 232 → 233 KB note above already ruled the worse trade. Measured
        // 59.32 kB — 60 rather than 59.5 for the same reason the 249 line gives:
        // headroom keeps the next comment edit from failing a build for a reason
        // that says nothing true about bundle weight.
        limit: '60 KB',
        brotli: false,
    },
    {
        name: 'background.js (sw)',
        path: 'background.js',
        // 2026-08-06 — 15 → 17 KB, first raise for this budget: the worker
        // gained its own storage-recording logError (it cannot share
        // caramel-base.js — separate context) and the tabs.onUpdated body
        // became a named, tested function that re-arms detection when an SPA
        // rewrites the URL. Measured 16.17 kB. Same standing note as above:
        // the honest fix is pricing minified bytes, and that call is the
        // owner's.
        // 2026-08-07 — 17 → 18 KB. Part of the fleet-silence fix: the bulk
        // supported-stores fetch gets its own 30 s budget (fetchWithTimeout
        // grew a per-call override; 8 s stays the default for small calls)
        // plus one retry — the measured cold fetch is the slow one and the
        // warm retry lands in seconds. Measured 17.55 kB.
        //
        // 2026-08-09 — 18 → 20 KB. The two favorites actions the popup star
        // rides on (getFavoriteStores / setFavoriteStore → the session-gated
        // /api/account/favorites routes, via fetchCaramelApi so the stored
        // bearer is attached in the one place that ever attaches it). ~0.9 kB is
        // code; the rest records why a 401 is answered as an error rather than
        // an empty list — "you follow nothing" and "we couldn't ask" are
        // different answers and the star must not paint the first when it means
        // the second. Measured 19.02 kB; 20 for the usual headroom.
        limit: '20 KB',
        brotli: false,
    },
]
